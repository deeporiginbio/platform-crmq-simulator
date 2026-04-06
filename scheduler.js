/**
 * CRMQ Scheduler — Core Scheduling Engine
 * =========================================
 * Implements the Priority Queue scheduling logic from the CRMQ design doc (§3).
 *
 * Responsibilities:
 *  - Priority scoring: Score = (OrgP × W) + (UserP × W) + (ToolP × W) + (WaitTime × AgingFactor)
 *  - Top-N dispatcher with two admission gates
 *  - Gate 1: Org Quota Check (skip on fail, don't block queue)
 *  - Gate 2: Global Capacity Check (cluster resources)
 *  - Backfilling: short-duration lower-priority jobs fill gaps
 *  - Reservation Mode: blocks new dispatches after skip_count > threshold
 *  - TTL eviction: removes jobs that exceed their time-to-live
 *  - Resource lifecycle: acquire on dispatch, release on completion
 *
 * This module is pure logic — no UI, no DOM, no framework dependencies.
 * Attach to window.CRMQ for browser use, or export for Node.js/testing.
 */

(function (root) {
  'use strict';

  // ── Default Configuration ──────────────────────────────────────────────────

  const DEFAULT_CONFIG = {
    scoring: {
      orgWeight:    10000,
      userWeight:    1000,
      toolWeight:     100,
      agingFactor:      5,  // score pts added per second of wait
    },
    scheduler: {
      topN:               10,
      skipThreshold:       3,  // skip_count > X → reservation mode
      backfillMaxRatio:  0.5,  // backfill candidate duration ≤ ratio × blocked job duration
    },
    cluster: {
      total:    { cpu: 32, memory: 128, gpu: 4 },
      reserved: { cpu:  4, memory:  16, gpu: 0 },  // platform reservation (K8s overhead)
    },
    ttlDefault: 300,  // seconds
  };

  const DEFAULT_ORGS = [
    { id: 'org-alpha', name: 'Org Alpha', priority: 3, limits: { cpu: 16, memory: 64, gpu: 2 } },
    { id: 'org-beta',  name: 'Org Beta',  priority: 2, limits: { cpu:  8, memory: 32, gpu: 1 } },
    { id: 'org-gamma', name: 'Org Gamma', priority: 1, limits: { cpu:  8, memory: 32, gpu: 2 } },
  ];

  const PRESET_JOBS = [
    { name: 'Ligand Prep',         orgId: 'org-alpha', userPriority: 3, toolPriority: 2, resources: { cpu:  2, memory:  8, gpu: 0 }, estimatedDuration:  45, ttl: 300 },
    { name: 'GPU Docking (large)', orgId: 'org-alpha', userPriority: 5, toolPriority: 4, resources: { cpu:  4, memory: 16, gpu: 2 }, estimatedDuration: 120, ttl: 300 },
    { name: 'Data Ingestion',      orgId: 'org-beta',  userPriority: 2, toolPriority: 1, resources: { cpu:  1, memory:  4, gpu: 0 }, estimatedDuration:  30, ttl: 200 },
    { name: 'ML Training',         orgId: 'org-beta',  userPriority: 4, toolPriority: 3, resources: { cpu:  8, memory: 32, gpu: 1 }, estimatedDuration: 180, ttl: 400 },
    { name: 'API Serving',         orgId: 'org-gamma', userPriority: 5, toolPriority: 5, resources: { cpu:  2, memory:  8, gpu: 0 }, estimatedDuration:  60, ttl: 250 },
    { name: 'Pocket Finding',      orgId: 'org-gamma', userPriority: 3, toolPriority: 2, resources: { cpu:  4, memory: 16, gpu: 1 }, estimatedDuration:  90, ttl: 300 },
    { name: 'Parallel Docking ×4', orgId: 'org-alpha', userPriority: 4, toolPriority: 3, resources: { cpu: 16, memory: 64, gpu: 4 }, estimatedDuration: 200, ttl: 500 },
    { name: 'Quick Analysis',      orgId: 'org-beta',  userPriority: 2, toolPriority: 1, resources: { cpu:  1, memory:  2, gpu: 0 }, estimatedDuration:  15, ttl: 150 },
  ];


  // ── Resource Math ──────────────────────────────────────────────────────────

  const ZERO = Object.freeze({ cpu: 0, memory: 0, gpu: 0 });

  function add3(a, b) {
    return { cpu: a.cpu + b.cpu, memory: a.memory + b.memory, gpu: a.gpu + b.gpu };
  }

  function sub3(a, b) {
    return { cpu: a.cpu - b.cpu, memory: a.memory - b.memory, gpu: a.gpu - b.gpu };
  }

  function fits(req, avail) {
    return req.cpu <= avail.cpu && req.memory <= avail.memory && req.gpu <= avail.gpu;
  }

  function sumResources(jobs) {
    return jobs.reduce(function (acc, j) { return add3(acc, j.resources); }, { cpu: 0, memory: 0, gpu: 0 });
  }

  function cloneZero() { return { cpu: 0, memory: 0, gpu: 0 }; }


  // ── Priority Scoring (§3.1) ────────────────────────────────────────────────
  //
  //  Score = (Org Priority × orgWeight)
  //        + (User Priority × userWeight)
  //        + (Tool Priority × toolWeight)
  //        + (WaitTime × agingFactor)
  //

  function calcScore(job, now, config, orgs) {
    var org  = orgs.find(function (o) { return o.id === job.orgId; }) || { priority: 1 };
    var wait = Math.max(0, now - job.enqueuedAt);
    var s    = config.scoring;
    return (
      org.priority       * s.orgWeight  +
      job.userPriority   * s.userWeight +
      job.toolPriority   * s.toolWeight +
      wait               * s.agingFactor
    );
  }


  // ── Cluster Availability ───────────────────────────────────────────────────
  //
  //  Available = Total - Reserved - InUse
  //

  function getAvailability(config, activeJobs) {
    var inUse = sumResources(activeJobs);
    var cl    = config.cluster;
    return sub3(sub3(cl.total, cl.reserved), inUse);
  }


  // ── TTL Eviction (§1.2) ────────────────────────────────────────────────────

  function evictExpired(queue, now, logFn) {
    var live    = [];
    var evicted = [];
    for (var i = 0; i < queue.length; i++) {
      var j   = queue[i];
      var age = now - j.enqueuedAt;
      if (age >= j.ttl) {
        evicted.push(Object.assign({}, j, { evictedAt: now }));
        if (logFn) logFn(now, '\u23F0 TTL EVICT | ' + j.name + ' [' + j.id + '] \u2014 waited ' + fmtTime(age) + ', TTL was ' + fmtTime(j.ttl), 'error');
      } else {
        live.push(j);
      }
    }
    return { live: live, evicted: evicted };
  }


  // ── Complete Finished Jobs ─────────────────────────────────────────────────

  function completeJobs(activeJobs, dt, now, orgUsage, logFn) {
    var stillRunning = [];
    var completed    = [];
    var updOrgUsage  = shallowCloneOrgUsage(orgUsage);

    for (var i = 0; i < activeJobs.length; i++) {
      var j   = activeJobs[i];
      var rem = j.remainingDuration - dt;
      if (rem <= 0) {
        completed.push(Object.assign({}, j, { completedAt: now }));
        updOrgUsage[j.orgId] = sub3(updOrgUsage[j.orgId] || cloneZero(), j.resources);
        if (logFn) logFn(now, '\uD83C\uDFC1 COMPLETE | ' + j.name + ' [' + j.id + '] \u2014 ran ' + fmtTime(j.estimatedDuration) + ', resources released', 'success');
      } else {
        stillRunning.push(Object.assign({}, j, { remainingDuration: rem }));
      }
    }

    return { stillRunning: stillRunning, completed: completed, orgUsage: updOrgUsage };
  }


  // ── Scheduling Strategy (§3.2 / §3.3 / §3.4) ─────────────────────────────
  //
  //  1. Score & sort queue → take Top N
  //  2. For each item:
  //     a. Gate 1 — Org Quota: Org_Used + Request ≤ Org_Limit  (SKIP on fail)
  //     b. Reservation mode gate: only reservation target passes
  //     c. Gate 2 — Global Capacity: Cluster_Free ≥ Request
  //        - On fail: increment skip_count; if > threshold → reservation mode
  //        - Backfill: find lower-priority short-duration job that fits
  //     d. On pass: dispatch
  //

  function runScheduler(queue, active, orgUsage, reservMode, reservTarget, now, config, orgs, logFn) {
    var inUse = sumResources(active);
    var cl    = config.cluster;
    var avail = sub3(sub3(cl.total, cl.reserved), inUse);
    var sch   = config.scheduler;

    // Score and rank
    var ranked = queue
      .map(function (j) { return Object.assign({}, j, { _score: calcScore(j, now, config, orgs) }); })
      .sort(function (a, b) { return b._score - a._score; });

    var topN = ranked.slice(0, sch.topN);

    var nq = ranked.slice();
    var na = active.slice();
    var no = shallowCloneOrgUsage(orgUsage);
    var nr = reservMode;
    var nt = reservTarget;

    // Validate reservation target still exists
    if (nr && nt && !nq.find(function (j) { return j.id === nt; })) {
      nr = false; nt = null;
      if (logFn) logFn(now, '\uD83D\uDD13 Reservation mode lifted \u2014 target no longer in queue', 'info');
    }

    var dispatched = false;

    for (var ti = 0; ti < topN.length; ti++) {
      if (dispatched) break;
      var job = topN[ti];

      var org       = orgs.find(function (o) { return o.id === job.orgId; });
      var orgLimits = org ? org.limits : { cpu: 9999, memory: 9999, gpu: 9999 };
      var orgUsed   = no[job.orgId] || cloneZero();

      // ── Gate 1: Org Quota ─────────────────────────────────────────────
      var orgOk = (
        orgUsed.cpu    + job.resources.cpu    <= orgLimits.cpu    &&
        orgUsed.memory + job.resources.memory <= orgLimits.memory &&
        orgUsed.gpu    + job.resources.gpu    <= orgLimits.gpu
      );
      if (!orgOk) {
        if (logFn) logFn(now, '\u26D4 Gate 1 FAIL | ' + job.name + ' [' + job.id + '] \u2014 ' + (org ? org.name : job.orgId) + ' quota exceeded (SKIP)', 'warn');
        nq = nq.map(function (j) { return j.id === job.id ? Object.assign({}, j, { skipCount: (j.skipCount || 0) + 1 }) : j; });
        continue;
      }

      // ── Reservation mode gate ─────────────────────────────────────────
      if (nr && nt && job.id !== nt) {
        if (logFn) logFn(now, '\uD83D\uDD12 Reservation mode | blocking ' + job.name + ' [' + job.id + '] \u2014 reserving for ' + nt, 'warn');
        continue;
      }

      // ── Gate 2: Global Capacity ───────────────────────────────────────
      var capOk = fits(job.resources, avail);
      if (!capOk) {
        var newSkip = (job.skipCount || 0) + 1;
        nq = nq.map(function (j) { return j.id === job.id ? Object.assign({}, j, { skipCount: newSkip }) : j; });
        if (logFn) logFn(now, '\u26D4 Gate 2 FAIL | ' + job.name + ' [' + job.id + '] \u2014 capacity insufficient. skip_count=' + newSkip + '/' + sch.skipThreshold, 'warn');

        // §3.4 Large Task Guarantees
        if (newSkip > sch.skipThreshold && !nr) {
          nr = true; nt = job.id;
          if (logFn) logFn(now, '\uD83D\uDD12 RESERVATION MODE ON | ' + job.name + ' [' + job.id + '] skipped ' + newSkip + '\u00D7 \u2014 blocking new dispatches', 'error');
        }

        // §3.3 Backfilling (only for top blocked item, only when NOT in reservation mode)
        if (job.id === topN[0].id && !nr) {
          var candidates = ranked
            .filter(function (j) { return j.id !== job.id && j._score < job._score; })
            .filter(function (j) { return fits(j.resources, avail); })
            .filter(function (j) { return j.estimatedDuration <= job.estimatedDuration * sch.backfillMaxRatio; });

          for (var ci = 0; ci < candidates.length; ci++) {
            var bf        = candidates[ci];
            var bfOrgUsed = no[bf.orgId] || cloneZero();
            var bfOrg     = orgs.find(function (o) { return o.id === bf.orgId; });
            var bfLimits  = bfOrg ? bfOrg.limits : { cpu: 9999, memory: 9999, gpu: 9999 };
            var bfOrgOk   = (
              bfOrgUsed.cpu    + bf.resources.cpu    <= bfLimits.cpu    &&
              bfOrgUsed.memory + bf.resources.memory <= bfLimits.memory &&
              bfOrgUsed.gpu    + bf.resources.gpu    <= bfLimits.gpu
            );
            if (bfOrgOk) {
              na = na.concat([Object.assign({}, bf, { startedAt: now, remainingDuration: bf.estimatedDuration })]);
              nq = nq.filter(function (j) { return j.id !== bf.id; });
              no = Object.assign({}, no);
              no[bf.orgId] = add3(no[bf.orgId] || cloneZero(), bf.resources);
              avail = sub3(avail, bf.resources);
              if (logFn) logFn(now, '\uD83D\uDD00 BACKFILL | ' + bf.name + ' [' + bf.id + '] \u2014 fits gap, dur ' + fmtTime(bf.estimatedDuration) + ' \u2264 ' + (sch.backfillMaxRatio * 100) + '% of blocked', 'success');
              dispatched = true;
              break;
            }
          }
        }
        continue;
      }

      // ── DISPATCH ──────────────────────────────────────────────────────
      var wait = now - job.enqueuedAt;
      if (logFn) logFn(now, '\u2705 DISPATCH | ' + job.name + ' [' + job.id + '] \u2014 score=' + Math.round(job._score).toLocaleString() + ', wait=' + fmtTime(wait) + ', CPU:' + job.resources.cpu + ' MEM:' + job.resources.memory + 'GB GPU:' + job.resources.gpu, 'success');

      na = na.concat([Object.assign({}, job, { startedAt: now, remainingDuration: job.estimatedDuration })]);
      nq = nq.filter(function (j) { return j.id !== job.id; });
      no = Object.assign({}, no);
      no[job.orgId] = add3(no[job.orgId] || cloneZero(), job.resources);
      avail = sub3(avail, job.resources);

      if (nr && nt === job.id) {
        nr = false; nt = null;
        if (logFn) logFn(now, '\uD83D\uDD13 Reservation mode cleared \u2014 target dispatched', 'info');
      }
      dispatched = true;
    }

    return { queue: nq, active: na, orgUsage: no, reservMode: nr, reservTarget: nt, dispatched: dispatched };
  }


  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    if (s < 60)   return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }

  var _jobId = 1;
  function newJobId() {
    return 'job-' + String(_jobId++).padStart(3, '0');
  }

  function resetJobIdCounter() { _jobId = 1; }

  function shallowCloneOrgUsage(ou) {
    var result = {};
    for (var key in ou) {
      if (ou.hasOwnProperty(key)) {
        result[key] = { cpu: ou[key].cpu, memory: ou[key].memory, gpu: ou[key].gpu };
      }
    }
    return result;
  }


  // ── Public API ─────────────────────────────────────────────────────────────

  var Scheduler = {
    // Config & data
    DEFAULT_CONFIG:  DEFAULT_CONFIG,
    DEFAULT_ORGS:    DEFAULT_ORGS,
    PRESET_JOBS:     PRESET_JOBS,

    // Resource math
    ZERO:           ZERO,
    add3:           add3,
    sub3:           sub3,
    fits:           fits,
    sumResources:   sumResources,

    // Core logic
    calcScore:      calcScore,
    getAvailability: getAvailability,
    evictExpired:   evictExpired,
    completeJobs:   completeJobs,
    runScheduler:   runScheduler,

    // Helpers
    fmtTime:        fmtTime,
    newJobId:       newJobId,
    resetJobIdCounter: resetJobIdCounter,
    shallowCloneOrgUsage: shallowCloneOrgUsage,
  };

  // Expose
  root.CRMQ = root.CRMQ || {};
  root.CRMQ.Scheduler = Scheduler;

})(typeof window !== 'undefined' ? window : global);
