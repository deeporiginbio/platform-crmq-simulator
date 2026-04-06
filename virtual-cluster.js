/**
 * CRMQ Virtual Cluster — Time-to-Start Estimation Engine
 * =======================================================
 * Implements the "Virtual Cluster" concept from the CRMQ design doc (§2.3).
 *
 * The Virtual Cluster is an in-memory simulation that:
 *  1. Snapshots the current cluster state (running jobs, queue, org usage, resources)
 *  2. Fast-forwards time using an event-driven approach
 *     (jumps to next job completion, not tick-by-tick)
 *  3. Applies the EXACT same scheduling logic (from scheduler.js) at each event
 *  4. Records when each queued job gets dispatched → Time-to-Start Delta
 *  5. Identifies the blocking reason for each waiting job
 *  6. Computes a confidence variance (±%) based on estimation uncertainty
 *
 * From §1.5 — Visibility & Estimation:
 *  - Time-to-Start Delta: estimated seconds until resources become available
 *  - Dynamic Recalculation: re-run when queue changes
 *  - Contextual Status: WAITING_FOR_GPU_CAPACITY, BLOCKED_BY_ORG_QUOTA, etc.
 *  - Confidence Variance: ±X% for "Probable Start Window"
 *
 * From §2.3 — Execution Time Estimation:
 *  - Background loop creates in-memory "Virtual Cluster"
 *  - Fast-forwards time, releasing resources as jobs finish
 *  - Applies exact scheduling logic to place queued jobs on timeline
 *  - Workflow Affinity: pins subsequent steps to same cluster
 *
 * Dependencies: scheduler.js (must be loaded first → window.CRMQ.Scheduler)
 */

(function (root) {
  'use strict';

  var S = root.CRMQ && root.CRMQ.Scheduler;
  if (!S) throw new Error('virtual-cluster.js requires scheduler.js to be loaded first (window.CRMQ.Scheduler)');


  // ── Blocking Reasons (§1.5 Contextual Status) ─────────────────────────────

  var BlockingReason = {
    NONE:                          'NONE',
    WAITING_FOR_CPU_CAPACITY:      'WAITING_FOR_CPU_CAPACITY',
    WAITING_FOR_MEMORY_CAPACITY:   'WAITING_FOR_MEMORY_CAPACITY',
    WAITING_FOR_GPU_CAPACITY:      'WAITING_FOR_GPU_CAPACITY',
    WAITING_FOR_MULTI_RESOURCE:    'WAITING_FOR_MULTI_RESOURCE',
    BLOCKED_BY_ORG_QUOTA:          'BLOCKED_BY_ORG_QUOTA',
    QUEUED_BEHIND_HIGHER_PRIORITY: 'QUEUED_BEHIND_HIGHER_PRIORITY',
    BLOCKED_BY_RESERVATION_MODE:   'BLOCKED_BY_RESERVATION_MODE',
    WILL_EXCEED_TTL:               'WILL_EXCEED_TTL',
    UNKNOWN:                       'UNKNOWN',
  };


  // ── Deep Clone Helpers ─────────────────────────────────────────────────────

  function deepCloneJob(j) {
    return {
      id: j.id, name: j.name, orgId: j.orgId,
      userPriority: j.userPriority, toolPriority: j.toolPriority,
      resources: { cpu: j.resources.cpu, memory: j.resources.memory, gpu: j.resources.gpu },
      estimatedDuration: j.estimatedDuration, ttl: j.ttl,
      enqueuedAt: j.enqueuedAt, skipCount: j.skipCount || 0,
      startedAt: j.startedAt, remainingDuration: j.remainingDuration,
      clusterId: j.clusterId || null,  // workflow affinity
    };
  }

  function deepCloneArray(arr) {
    return arr.map(deepCloneJob);
  }


  // ── Determine Specific Blocking Reason ─────────────────────────────────────

  function determineBlockingReason(job, avail, orgUsage, orgs, reservMode, reservTarget, queueRank) {
    var org       = orgs.find(function (o) { return o.id === job.orgId; });
    var orgLimits = org ? org.limits : { cpu: 9999, memory: 9999, gpu: 9999 };
    var orgUsed   = orgUsage[job.orgId] || { cpu: 0, memory: 0, gpu: 0 };

    // Check org quota first
    var orgOk = (
      orgUsed.cpu    + job.resources.cpu    <= orgLimits.cpu    &&
      orgUsed.memory + job.resources.memory <= orgLimits.memory &&
      orgUsed.gpu    + job.resources.gpu    <= orgLimits.gpu
    );
    if (!orgOk) return BlockingReason.BLOCKED_BY_ORG_QUOTA;

    // Reservation mode
    if (reservMode && reservTarget && job.id !== reservTarget) {
      return BlockingReason.BLOCKED_BY_RESERVATION_MODE;
    }

    // Capacity checks — identify which resource dimension is the bottleneck
    var cpuShort = job.resources.cpu    > avail.cpu;
    var memShort = job.resources.memory > avail.memory;
    var gpuShort = job.resources.gpu    > avail.gpu;

    var shortCount = (cpuShort ? 1 : 0) + (memShort ? 1 : 0) + (gpuShort ? 1 : 0);

    if (shortCount > 1) return BlockingReason.WAITING_FOR_MULTI_RESOURCE;
    if (gpuShort)       return BlockingReason.WAITING_FOR_GPU_CAPACITY;
    if (cpuShort)       return BlockingReason.WAITING_FOR_CPU_CAPACITY;
    if (memShort)       return BlockingReason.WAITING_FOR_MEMORY_CAPACITY;

    // Resources are technically available but job is behind higher-priority items
    if (queueRank > 0)  return BlockingReason.QUEUED_BEHIND_HIGHER_PRIORITY;

    return BlockingReason.UNKNOWN;
  }


  // ── Confidence Variance Calculation ────────────────────────────────────────
  //
  // Variance increases with:
  //  - Queue depth (more jobs ahead = more uncertainty)
  //  - Estimation error (running jobs may finish faster/slower)
  //  - Backfill potential (hard to predict)
  //
  // Returns a percentage (0–100) representing ±variance

  function calcVariance(job, prediction, queueDepth, activeCount) {
    var baseVariance = 5;  // minimum ±5%

    // Queue depth factor: +2% per job ahead in queue
    var depthFactor = Math.min(30, prediction.queueRank * 2);

    // Time horizon factor: further out = more uncertain (+1% per 60s)
    var timeFactor = Math.min(25, Math.floor(prediction.delta / 60));

    // Active job count factor: more running jobs = more completion events = more variance
    var activeFactor = Math.min(15, activeCount * 1.5);

    return Math.min(50, Math.round(baseVariance + depthFactor + timeFactor + activeFactor));
  }


  // ── Virtual Cluster: Predict Time-to-Start ─────────────────────────────────
  //
  // This is the core estimation engine from §2.3.
  //
  // Algorithm:
  //  1. Deep-clone current state (queue, active, org usage)
  //  2. Find the next "event" (earliest running job completion)
  //  3. Jump time to that event
  //  4. Release completed job resources
  //  5. Run scheduler to try dispatching queued jobs
  //  6. Record predictions for any newly dispatched jobs
  //  7. Repeat until queue is empty or max iterations reached
  //
  // Returns: Map<jobId, Prediction>
  //   Prediction = { delta, estimatedStartTime, blockingReason, variance, queueRank, status }

  function predict(currentQueue, currentActive, currentOrgUsage, currentTime, config, orgs) {
    // 1. Deep clone everything — this is an in-memory "virtual" cluster
    var simQueue    = deepCloneArray(currentQueue);
    var simActive   = deepCloneArray(currentActive);
    var simOrgUsage = S.shallowCloneOrgUsage(currentOrgUsage);
    var simTime     = currentTime;
    var simReservMode   = false;
    var simReservTarget = null;

    var predictions = {};  // jobId → Prediction

    // Initialize predictions for all queued jobs (pessimistic defaults)
    var rankedInit = simQueue
      .map(function (j) { return { id: j.id, score: S.calcScore(j, simTime, config, orgs) }; })
      .sort(function (a, b) { return b.score - a.score; });

    for (var ri = 0; ri < rankedInit.length; ri++) {
      var ji = simQueue.find(function (j) { return j.id === rankedInit[ri].id; });
      var initAvail = S.getAvailability(config, simActive);
      predictions[ji.id] = {
        delta:              null,  // unknown yet
        estimatedStartTime: null,
        blockingReason:     determineBlockingReason(ji, initAvail, simOrgUsage, orgs, simReservMode, simReservTarget, ri),
        variance:           null,
        queueRank:          ri,
        status:             'WAITING',
      };
    }

    // 2. Event-driven fast-forward loop
    var MAX_ITERATIONS = 500;
    var iteration      = 0;

    while (simQueue.length > 0 && iteration < MAX_ITERATIONS) {
      iteration++;

      // ── Try dispatching with current resources first ──────────────────
      var beforeCount = simQueue.length;
      var result = S.runScheduler(
        simQueue, simActive, simOrgUsage,
        simReservMode, simReservTarget,
        simTime, config, orgs,
        null  // no logging in virtual cluster — it's silent
      );

      simQueue      = result.queue;
      simActive     = result.active;
      simOrgUsage   = result.orgUsage;
      simReservMode = result.reservMode;
      simReservTarget = result.reservTarget;

      // Record predictions for any jobs that just got dispatched
      var afterCount = simQueue.length;
      if (afterCount < beforeCount) {
        // Find which jobs were dispatched (in simActive but not in simQueue)
        var queueIds = {};
        for (var qi = 0; qi < simQueue.length; qi++) queueIds[simQueue[qi].id] = true;

        for (var ai = 0; ai < simActive.length; ai++) {
          var aj = simActive[ai];
          if (predictions[aj.id] && predictions[aj.id].status === 'WAITING') {
            predictions[aj.id].delta              = Math.max(0, simTime - currentTime);
            predictions[aj.id].estimatedStartTime = simTime;
            predictions[aj.id].blockingReason     = BlockingReason.NONE;
            predictions[aj.id].status             = 'PREDICTED';
          }
        }

        // Continue trying to dispatch more in the same tick
        continue;
      }

      // ── No more dispatches possible now — find next completion event ──
      if (simActive.length === 0) {
        // No running jobs and nothing could be dispatched — everything is blocked on external capacity
        break;
      }

      // Find earliest completion time
      var nextCompletionTime = Infinity;
      for (var ni = 0; ni < simActive.length; ni++) {
        var finishTime = simActive[ni].startedAt + simActive[ni].estimatedDuration;
        if (finishTime < nextCompletionTime) {
          nextCompletionTime = finishTime;
        }
      }

      if (nextCompletionTime === Infinity || nextCompletionTime <= simTime) {
        // Safety: avoid infinite loops
        break;
      }

      // Jump time to the next completion
      var dt = nextCompletionTime - simTime;
      simTime = nextCompletionTime;

      // Complete finished jobs and release resources
      var completionResult = S.completeJobs(simActive, dt, simTime, simOrgUsage, null);
      simActive   = completionResult.stillRunning;
      simOrgUsage = completionResult.orgUsage;

      // TTL eviction check
      var ttlResult = S.evictExpired(simQueue, simTime, null);
      simQueue = ttlResult.live;

      // Mark evicted jobs in predictions
      for (var ei = 0; ei < ttlResult.evicted.length; ei++) {
        var ej = ttlResult.evicted[ei];
        if (predictions[ej.id]) {
          predictions[ej.id].status         = 'WILL_EXPIRE';
          predictions[ej.id].blockingReason = BlockingReason.WILL_EXCEED_TTL;
          predictions[ej.id].delta          = ej.ttl;
        }
      }

      // Update blocking reasons for remaining queued jobs
      var rankedNow = simQueue
        .map(function (j) { return { id: j.id, score: S.calcScore(j, simTime, config, orgs) }; })
        .sort(function (a, b) { return b.score - a.score; });

      var simAvail = S.getAvailability(config, simActive);

      for (var ui = 0; ui < rankedNow.length; ui++) {
        var uj = simQueue.find(function (j) { return j.id === rankedNow[ui].id; });
        if (predictions[uj.id] && predictions[uj.id].status === 'WAITING') {
          predictions[uj.id].blockingReason = determineBlockingReason(
            uj, simAvail, simOrgUsage, orgs, simReservMode, simReservTarget, ui
          );
          predictions[uj.id].queueRank = ui;
        }
      }
    }

    // ── Compute variance for all predictions ────────────────────────────────
    var activeCount = currentActive.length;
    for (var pid in predictions) {
      if (predictions.hasOwnProperty(pid)) {
        var pred = predictions[pid];
        if (pred.status === 'PREDICTED' && pred.delta !== null) {
          pred.variance = calcVariance(
            null, pred,
            currentQueue.length, activeCount
          );
        } else if (pred.status === 'WAITING') {
          // Could not be placed within simulation horizon
          pred.status         = 'UNPREDICTABLE';
          pred.variance       = 50;  // max uncertainty
          pred.blockingReason = pred.blockingReason || BlockingReason.UNKNOWN;
        }
      }
    }

    return predictions;
  }


  // ── Format Prediction for Display ──────────────────────────────────────────

  function formatPrediction(pred) {
    if (!pred) return { label: 'Unknown', detail: '', css: 'text-slate-500' };

    switch (pred.status) {
      case 'PREDICTED':
        var low  = Math.max(0, Math.round(pred.delta * (1 - pred.variance / 100)));
        var high = Math.round(pred.delta * (1 + pred.variance / 100));
        return {
          label:  S.fmtTime(pred.delta),
          window: S.fmtTime(low) + ' – ' + S.fmtTime(high),
          detail: '\u00B1' + pred.variance + '%',
          css:    pred.delta < 60 ? 'text-green-400' : pred.delta < 300 ? 'text-blue-400' : 'text-amber-400',
        };

      case 'WILL_EXPIRE':
        return {
          label:  'Will expire',
          window: 'TTL exceeded before resources available',
          detail: 'TTL: ' + S.fmtTime(pred.delta || 0),
          css:    'text-red-400',
        };

      case 'UNPREDICTABLE':
        return {
          label:  'Unknown',
          window: 'Cannot estimate — no capacity event in simulation horizon',
          detail: pred.blockingReason,
          css:    'text-slate-500',
        };

      default:
        return { label: '—', window: '', detail: '', css: 'text-slate-600' };
    }
  }


  // ── Blocking Reason Labels ─────────────────────────────────────────────────

  var REASON_LABELS = {};
  REASON_LABELS[BlockingReason.NONE]                          = { label: 'Ready',               icon: '\u2705', css: 'text-green-400'  };
  REASON_LABELS[BlockingReason.WAITING_FOR_CPU_CAPACITY]      = { label: 'Waiting for CPU',     icon: '\uD83D\uDDA5',  css: 'text-blue-400'   };
  REASON_LABELS[BlockingReason.WAITING_FOR_MEMORY_CAPACITY]   = { label: 'Waiting for Memory',  icon: '\uD83D\uDCBE', css: 'text-purple-400' };
  REASON_LABELS[BlockingReason.WAITING_FOR_GPU_CAPACITY]      = { label: 'Waiting for GPU',     icon: '\uD83C\uDFAE', css: 'text-amber-400'  };
  REASON_LABELS[BlockingReason.WAITING_FOR_MULTI_RESOURCE]    = { label: 'Multi-resource wait', icon: '\uD83D\uDCE6', css: 'text-orange-400' };
  REASON_LABELS[BlockingReason.BLOCKED_BY_ORG_QUOTA]          = { label: 'Org quota limit',     icon: '\uD83C\uDFE2', css: 'text-red-400'    };
  REASON_LABELS[BlockingReason.QUEUED_BEHIND_HIGHER_PRIORITY] = { label: 'Behind higher-P',     icon: '\u2B06',  css: 'text-cyan-400'   };
  REASON_LABELS[BlockingReason.BLOCKED_BY_RESERVATION_MODE]   = { label: 'Reservation block',   icon: '\uD83D\uDD12', css: 'text-purple-400' };
  REASON_LABELS[BlockingReason.WILL_EXCEED_TTL]               = { label: 'Will exceed TTL',     icon: '\u23F0', css: 'text-red-400'    };
  REASON_LABELS[BlockingReason.UNKNOWN]                       = { label: 'Unknown',             icon: '\u2753', css: 'text-slate-500'  };

  function getReasonLabel(reason) {
    return REASON_LABELS[reason] || REASON_LABELS[BlockingReason.UNKNOWN];
  }


  // ── Public API ─────────────────────────────────────────────────────────────

  var VirtualCluster = {
    // Core
    predict:             predict,

    // Blocking reasons
    BlockingReason:      BlockingReason,
    determineBlockingReason: determineBlockingReason,

    // Display helpers
    formatPrediction:    formatPrediction,
    getReasonLabel:      getReasonLabel,
    calcVariance:        calcVariance,
    REASON_LABELS:       REASON_LABELS,
  };

  // Expose
  root.CRMQ = root.CRMQ || {};
  root.CRMQ.VirtualCluster = VirtualCluster;

})(typeof window !== 'undefined' ? window : global);
