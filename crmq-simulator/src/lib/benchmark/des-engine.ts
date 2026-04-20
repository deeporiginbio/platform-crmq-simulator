/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Discrete Event Simulation Engine
 * ====================================================
 * Headless DES engine as recommended by §5.1 of the research report.
 *
 * Unlike the visual sim-store (time-stepped for smooth UI), this engine
 * jumps from event to event, skipping idle time.  It's optimized for
 * running thousands of scenarios quickly.
 *
 * Event types:
 *   JOB_ARRIVAL    — a job enters the queue
 *   JOB_COMPLETION — a running job finishes
 *   TTL_EXPIRY     — a queued job exceeds its TTL
 *
 * The engine uses the SAME scheduler logic (scheduler.ts) as the visual sim,
 * guaranteeing behavioral equivalence.
 */

import type {
  Job,
  RunningJob,
  CRMQConfig,
  Org,
  OrgUsageMap,
  Resources,
} from '../types';
import { getJobPoolType } from '../types';
import {
  calcScore,
  zeroPoolUsage,
  newJobId,
  resetJobIdCounter,
  fits,
  add3,
  sub3,
  cloneZero,
  shallowCloneOrgUsage,
} from '../scheduler';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '../units';
import type { GeneratedJob } from './traffic';
import type { JobEvent, UtilizationSample } from './metrics';

// ── Event Queue ───────────────────────────────────────────────────────────

type EventType = 'JOB_ARRIVAL' | 'JOB_COMPLETION' | 'TTL_EXPIRY';

interface SimEvent {
  time: number;
  type: EventType;
  jobId?: string;
  /** For JOB_ARRIVAL, the job template to enqueue */
  jobTemplate?: GeneratedJob;
}

/**
 * Binary min-heap priority queue.
 * push / pop are O(log n) — critical for
 * 75K+ events where the old sorted-insert
 * (O(n) splice per push) was the bottleneck.
 */
class EventQueue {
  private h: SimEvent[] = [];

  push(e: SimEvent): void {
    const heap = this.h;
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].time <= heap[i].time) break;
      const tmp = heap[p];
      heap[p] = heap[i];
      heap[i] = tmp;
      i = p;
    }
  }

  pop(): SimEvent | undefined {
    const heap = this.h;
    const len = heap.length;
    if (len === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let s = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (
          l < heap.length &&
          heap[l].time < heap[s].time
        )
          s = l;
        if (
          r < heap.length &&
          heap[r].time < heap[s].time
        )
          s = r;
        if (s === i) break;
        const tmp = heap[i];
        heap[i] = heap[s];
        heap[s] = tmp;
        i = s;
      }
    }
    return top;
  }

  peek(): SimEvent | undefined {
    return this.h[0];
  }

  get size(): number {
    return this.h.length;
  }

  /** Remove events for a job (lazy — rare) */
  removeForJob(jobId: string): void {
    // Rebuild heap without the job's events
    const filtered = this.h.filter(
      (e) => e.jobId !== jobId,
    );
    this.h = [];
    for (const e of filtered) this.push(e);
  }
}

// ── Scoring Function Interface ────────────────────────────────────────────
// This allows the DES engine to accept custom scoring functions,
// leaving room for new formula implementations.
// NOTE: orgUsage is required for DRF, CFS, and Balanced Composite formulas.

export type ScoringFunction = (
  job: Job,
  now: number,
  config: CRMQConfig,
  orgs: Org[],
  orgUsage?: OrgUsageMap,
) => number;

// ── DES Engine Configuration ──────────────────────────────────────────────

export interface DESConfig {
  config: CRMQConfig;
  orgs: Org[];
  workload: GeneratedJob[];
  /** Optional custom scoring function — if not provided, uses scheduler.ts's calcScore */
  scoringFn?: ScoringFunction;
  /** Maximum sim-time to run (safety cap) */
  maxSimTime?: number;
  /** Maximum events to process (safety cap) */
  maxEvents?: number;
}

// ── DES Run Result ────────────────────────────────────────────────────────

export interface DESResult {
  events: JobEvent[];
  utilSamples: UtilizationSample[];
  simDuration: number;
  totalEventsProcessed: number;
  completedCount: number;
  evictedCount: number;
}

// ── Engine State ──────────────────────────────────────────────────────────

interface EngineState {
  simTime: number;
  queue: Job[];
  active: RunningJob[];
  /** Map of active job ID → RunningJob for
   *  O(1) lookup on completion events. */
  activeMap: Map<string, RunningJob>;
  orgUsage: OrgUsageMap;
  reservMode: boolean;
  reservTarget: string | null;
  /** Set of active job IDs for O(1) lookup */
  activeIds: Set<string>;
  /**
   * Free resources per pool — maintained
   * incrementally. Avoids O(active) recompute
   * on every capacity check.
   */
  freeByPool: Record<string, Resources>;
  /** Queue indexed by ID for O(1) TTL lookup */
  queueMap: Map<string, Job>;
}

// ── Shared DES Logic ─────────────────────────────────────────────────────
// Both sync and async variants share the same core event processing.

interface DESContext {
  config: CRMQConfig;
  orgs: Org[];
  scoringFn?: ScoringFunction;
  maxSimTime: number;
  maxEvents: number;
  state: EngineState;
  eq: EventQueue;
  jobEvents: Map<string, JobEvent>;
  utilSamples: UtilizationSample[];
  eventsProcessed: number;
  /** Last sim-time we sampled utilization */
  lastUtilSample: number;
}

const initContext = (
  desConfig: DESConfig,
): DESContext => {
  const { config, orgs, workload } = desConfig;
  const maxSimTime =
    desConfig.maxSimTime ?? 86400;
  const maxEvents =
    desConfig.maxEvents ?? 1_000_000;

  resetJobIdCounter();

  // Pre-compute free resources per pool
  const freeByPool: Record<string, Resources> =
    {};
  for (const pool of config.cluster.pools) {
    freeByPool[pool.type] = {
      cpuMillis:
        pool.total.cpuMillis - pool.reserved.cpuMillis,
      memoryMiB:
        pool.total.memoryMiB -
        pool.reserved.memoryMiB,
      gpu: pool.total.gpu - pool.reserved.gpu,
    };
  }

  const state: EngineState = {
    simTime: 0,
    queue: [],
    active: [],
    activeMap: new Map(),
    orgUsage: Object.fromEntries(
      orgs.map((o) => [
        o.id,
        zeroPoolUsage(config),
      ]),
    ),
    reservMode: false,
    reservTarget: null,
    activeIds: new Set(),
    freeByPool,
    queueMap: new Map(),
  };

  const eq = new EventQueue();
  for (const job of workload) {
    eq.push({
      time: job.arrivalTime,
      type: 'JOB_ARRIVAL',
      jobTemplate: job,
    });
  }

  return {
    config,
    orgs,
    scoringFn: desConfig.scoringFn,
    maxSimTime,
    maxEvents,
    state,
    eq,
    jobEvents: new Map(),
    utilSamples: [],
    eventsProcessed: 0,
    lastUtilSample: -999,
  };
};

const sampleUtilization = (ctx: DESContext) => {
  const { config, state } = ctx;
  const pools: Record<
    string,
    { used: Resources; total: Resources }
  > = {};
  for (const pool of config.cluster.pools) {
    const poolJobs = state.active.filter(
      (j) =>
        getJobPoolType(j, config) === pool.type,
    );
    const used = poolJobs.reduce<Resources>(
      (acc, j) => ({
        cpuMillis: acc.cpuMillis + j.resources.cpuMillis,
        memoryMiB: acc.memoryMiB + j.resources.memoryMiB,
        gpu: acc.gpu + j.resources.gpu,
      }),
      { cpuMillis: 0, memoryMiB: 0, gpu: 0 },
    );
    pools[pool.type] = {
      used,
      total: {
        cpuMillis: pool.total.cpuMillis - pool.reserved.cpuMillis,
        memoryMiB:
          pool.total.memoryMiB - pool.reserved.memoryMiB,
        gpu: pool.total.gpu - pool.reserved.gpu,
      },
    };
  }
  ctx.utilSamples.push({
    time: state.simTime,
    pools,
  });
};

/** Result flags from applying an event. */
interface ApplyResult {
  /** Something changed — need scheduling. */
  changed: boolean;
  /** A running job completed (capacity freed). */
  capacityFreed: boolean;
}

const APPLY_NOOP: ApplyResult = {
  changed: false,
  capacityFreed: false,
};

/**
 * Apply a single event's state changes WITHOUT
 * calling runScheduler.
 */
const applyEvent = (
  ctx: DESContext,
): ApplyResult => {
  const { config, state, eq, jobEvents } = ctx;
  const event = eq.pop()!;
  ctx.eventsProcessed++;

  if (event.time > ctx.maxSimTime)
    return APPLY_NOOP;
  state.simTime = event.time;

  switch (event.type) {
    case 'JOB_ARRIVAL': {
      const tmpl = event.jobTemplate!;
      const job: Job = {
        id: newJobId(),
        name: tmpl.name,
        orgId: tmpl.orgId,
        userPriority: tmpl.userPriority,
        toolPriority: tmpl.toolPriority,
        resources: { ...tmpl.resources },
        estimatedDuration:
          tmpl.estimatedDuration,
        ttl: tmpl.ttl,
        enqueuedAt: state.simTime,
        skipCount: 0,
      };
      state.queue.push(job);
      state.queueMap.set(job.id, job);
      jobEvents.set(job.id, {
        jobId: job.id,
        jobName: job.name,
        orgId: job.orgId,
        resources: { ...job.resources },
        poolType: getJobPoolType(job, config),
        enqueuedAt: state.simTime,
        startedAt: null,
        completedAt: null,
        evictedAt: null,
        estimatedDuration:
          job.estimatedDuration,
      });
      if (isFinite(job.ttl)) {
        eq.push({
          time: state.simTime + job.ttl,
          type: 'TTL_EXPIRY',
          jobId: job.id,
        });
      }
      return {
        changed: true,
        capacityFreed: false,
      };
    }
    case 'JOB_COMPLETION': {
      const jobId = event.jobId!;
      // O(1) lookup via activeMap
      const job = state.activeMap.get(jobId);
      if (!job) return APPLY_NOOP;
      state.activeMap.delete(jobId);
      state.activeIds.delete(jobId);
      // Remove from active array — swap with
      // last for O(1) instead of splice O(n)
      const ri = state.active.indexOf(job);
      if (ri >= 0) {
        const last =
          state.active[state.active.length - 1];
        state.active[ri] = last;
        state.active.pop();
      }
      const poolType = getJobPoolType(
        job,
        config,
      );
      // Update org usage
      const orgPools =
        state.orgUsage[job.orgId];
      if (orgPools?.[poolType]) {
        const p = orgPools[poolType];
        orgPools[poolType] = {
          cpuMillis: p.cpuMillis - job.resources.cpuMillis,
          memoryMiB:
            p.memoryMiB - job.resources.memoryMiB,
          gpu: p.gpu - job.resources.gpu,
        };
      }
      // Update incremental free pool
      const fp = state.freeByPool[poolType];
      if (fp) {
        fp.cpuMillis += job.resources.cpuMillis;
        fp.memoryMiB += job.resources.memoryMiB;
        fp.gpu += job.resources.gpu;
      }
      const ev = jobEvents.get(jobId);
      if (ev) ev.completedAt = state.simTime;
      return {
        changed: true,
        capacityFreed: true,
      };
    }
    case 'TTL_EXPIRY': {
      const jobId = event.jobId!;
      // O(1) lookup via queueMap
      const job = state.queueMap.get(jobId);
      if (!job) return APPLY_NOOP;
      const age =
        state.simTime - job.enqueuedAt;
      if (age < job.ttl) return APPLY_NOOP;
      // Remove from queue array
      const qi = state.queue.indexOf(job);
      if (qi >= 0) {
        const last =
          state.queue[state.queue.length - 1];
        state.queue[qi] = last;
        state.queue.pop();
      }
      state.queueMap.delete(jobId);
      const ev = jobEvents.get(jobId);
      if (ev) ev.evictedAt = state.simTime;
      if (
        state.reservMode &&
        state.reservTarget === jobId
      ) {
        state.reservMode = false;
        state.reservTarget = null;
      }
      return {
        changed: true,
        capacityFreed: false,
      };
    }
  }
  return APPLY_NOOP;
};

/** Utilization sampling interval (sim-seconds) */
const UTIL_SAMPLE_INTERVAL = 30;

/**
 * O(pools) capacity check using incremental
 * freeByPool. No iteration over active jobs.
 */
const hasAnyCapacityFast = (
  freeByPool: Record<string, Resources>,
  minJobRes: Resources,
): boolean => {
  for (const pt in freeByPool) {
    const f = freeByPool[pt];
    if (
      f.cpuMillis >= minJobRes.cpuMillis &&
      f.memoryMiB >= minJobRes.memoryMiB &&
      f.gpu >= minJobRes.gpu
    )
      return true;
  }
  return false;
};

// ── Scoring helpers ──────────────────────────

/**
 * Score array — parallel array of scores indexed
 * the same as state.queue. Avoids copying Job
 * objects just to attach a _score property.
 */
type ScoreEntry = { idx: number; score: number };

/**
 * Partial-sort helper: find the top-K entries
 * from a score array in O(N) average time using
 * Quickselect, then sort only those K entries.
 *
 * Falls back to full sort when K >= N/4 (the
 * overhead of Quickselect isn't worth it for
 * small arrays or large K).
 */
const topKByScore = (
  entries: ScoreEntry[],
  k: number,
): ScoreEntry[] => {
  const n = entries.length;
  if (n <= k) {
    entries.sort((a, b) => b.score - a.score);
    return entries;
  }
  // For small K relative to N, use selection
  if (k < n / 4) {
    // Simple O(N×K) selection — still much
    // faster than O(N log N) sort when K << N
    const result: ScoreEntry[] = [];
    const used = new Uint8Array(n);
    for (let i = 0; i < k; i++) {
      let bestIdx = -1;
      let bestScore = -Infinity;
      for (let j = 0; j < n; j++) {
        if (!used[j] && entries[j].score > bestScore) {
          bestScore = entries[j].score;
          bestIdx = j;
        }
      }
      if (bestIdx < 0) break;
      used[bestIdx] = 1;
      result.push(entries[bestIdx]);
    }
    return result;
  }
  // Fallback: full sort
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, k);
};

// ── Bulk Dispatch (DES-optimized) ───────────

/**
 * Score the queue, find top-N candidates, then
 * dispatch all fitting jobs in a single pass.
 * Mirrors the logic in runScheduler (org quotas,
 * pool capacity, reservation mode, backfilling)
 * but avoids re-scoring on every dispatch.
 *
 * Performance optimizations vs. naive approach:
 *  - Scores stored in a parallel array (no Job
 *    object copies via spread operator)
 *  - Partial sort: only find top-N instead of
 *    sorting the entire queue O(N log N)
 *  - Queue rebuilt in-place without copying
 *    when no jobs are dispatched
 *  - Backfill scans the full score array but
 *    only accesses queue[idx] (no copies)
 */
const desBulkDispatch = (
  ctx: DESContext,
): void => {
  const {
    config,
    orgs,
    scoringFn,
    state,
    eq,
  } = ctx;
  const sch = config.scheduler;
  const queue = state.queue;
  const qLen = queue.length;

  // Score function
  const scoreFn = scoringFn
    ? (j: Job) =>
        scoringFn(
          j,
          state.simTime,
          config,
          orgs,
          state.orgUsage,
        )
    : (j: Job) =>
        calcScore(
          j,
          state.simTime,
          config,
          orgs,
          state.orgUsage,
        );

  // Build parallel score array (no object copies)
  const scores: ScoreEntry[] = new Array(qLen);
  for (let i = 0; i < qLen; i++) {
    scores[i] = { idx: i, score: scoreFn(queue[i]) };
  }

  // Find reservation target index
  let reservMode = state.reservMode;
  let reservTarget = state.reservTarget;
  let reservIdx = -1;
  if (reservMode && reservTarget) {
    for (let i = 0; i < qLen; i++) {
      if (queue[i].id === reservTarget) {
        reservIdx = i;
        break;
      }
    }
    if (reservIdx < 0) {
      reservMode = false;
      reservTarget = null;
    }
  }

  // Get top-N candidates via partial sort.
  // topKByScore may mutate its input, but we
  // only use `scores` for backfill index lookup
  // where order doesn't matter — safe to reuse.
  const topEntries = topKByScore(
    [...scores],
    sch.topN,
  );

  // Ensure reservation target is in topN
  if (reservMode && reservIdx >= 0) {
    const inTop = topEntries.some(
      (e) => e.idx === reservIdx,
    );
    if (!inTop) {
      topEntries.push(scores[reservIdx]);
    }
  }

  // Working copies for mutation during pass
  const availByPool: Record<string, Resources> =
    {};
  for (const pt in state.freeByPool) {
    availByPool[pt] = {
      ...state.freeByPool[pt],
    };
  }
  let orgUsage = shallowCloneOrgUsage(
    state.orgUsage,
  );

  const dispatched = new Set<string>();
  let blockedTopJob: ScoreEntry | null = null;

  for (const entry of topEntries) {
    const job = queue[entry.idx];
    if (dispatched.has(job.id)) continue;

    const poolType = getJobPoolType(
      job,
      config,
    );
    const avail = availByPool[poolType];
    if (!avail) continue;

    // Gate: Org quota
    const org = orgs.find(
      (o) => o.id === job.orgId,
    );
    const orgLimits =
      org?.limits[poolType] ?? {
        cpuMillis: 9999000,
        memoryMiB: 9999000,
        gpu: 9999,
      };
    const orgPools =
      orgUsage[job.orgId] ??
      zeroPoolUsage(config);
    const orgUsedInPool =
      orgPools[poolType] ?? cloneZero();

    const orgOk =
      orgUsedInPool.cpuMillis + job.resources.cpuMillis <=
        orgLimits.cpuMillis &&
      orgUsedInPool.memoryMiB +
        job.resources.memoryMiB <=
        orgLimits.memoryMiB &&
      orgUsedInPool.gpu + job.resources.gpu <=
        orgLimits.gpu;
    if (!orgOk) continue;

    // Gate: Reservation mode
    if (
      reservMode &&
      reservTarget &&
      job.id !== reservTarget
    ) {
      continue;
    }

    // Gate: Pool capacity
    if (!fits(job.resources, avail)) {
      job.skipCount = (job.skipCount || 0) + 1;
      if (
        job.skipCount > sch.skipThreshold &&
        !reservMode
      ) {
        reservMode = true;
        reservTarget = job.id;
      }
      if (!blockedTopJob) blockedTopJob = entry;

      // Backfill: find a smaller job that fits
      const isReservTarget =
        reservMode &&
        reservTarget === job.id;
      if (
        (!reservMode &&
          blockedTopJob === entry) ||
        isReservTarget
      ) {
        // Scan full score array for backfill
        for (let bi = 0; bi < qLen; bi++) {
          const bf = queue[scores[bi].idx];
          if (dispatched.has(bf.id)) continue;
          if (bf.id === job.id) continue;
          if (
            !isReservTarget &&
            scores[bi].score >= entry.score
          )
            continue;
          const bfPool = getJobPoolType(
            bf,
            config,
          );
          const bfAvail = availByPool[bfPool];
          if (
            !bfAvail ||
            !fits(bf.resources, bfAvail)
          )
            continue;
          if (
            bf.estimatedDuration >
            job.estimatedDuration *
              sch.backfillMaxRatio
          )
            continue;
          const bfOrgPools =
            orgUsage[bf.orgId] ??
            zeroPoolUsage(config);
          const bfOrgUsed =
            bfOrgPools[bfPool] ?? cloneZero();
          const bfOrg = orgs.find(
            (o) => o.id === bf.orgId,
          );
          const bfLimits =
            bfOrg?.limits[bfPool] ?? {
              cpuMillis: 9999000,
              memoryMiB: 9999000,
              gpu: 9999,
            };
          if (
            bfOrgUsed.cpuMillis + bf.resources.cpuMillis >
              bfLimits.cpuMillis ||
            bfOrgUsed.memoryMiB +
              bf.resources.memoryMiB >
              bfLimits.memoryMiB ||
            bfOrgUsed.gpu + bf.resources.gpu >
              bfLimits.gpu
          )
            continue;
          dispatched.add(bf.id);
          availByPool[bfPool] = sub3(
            availByPool[bfPool],
            bf.resources,
          );
          const bfDispPools = {
            ...bfOrgPools,
          };
          bfDispPools[bfPool] = add3(
            bfDispPools[bfPool],
            bf.resources,
          );
          orgUsage = {
            ...orgUsage,
            [bf.orgId]: bfDispPools,
          };
          break;
        }
      }
      continue;
    }

    // ✅ DISPATCH
    dispatched.add(job.id);
    availByPool[poolType] = sub3(
      availByPool[poolType],
      job.resources,
    );
    const dispOrgPools = {
      ...(orgUsage[job.orgId] ??
        zeroPoolUsage(config)),
    };
    dispOrgPools[poolType] = add3(
      dispOrgPools[poolType],
      job.resources,
    );
    orgUsage = {
      ...orgUsage,
      [job.orgId]: dispOrgPools,
    };
    if (
      reservMode &&
      reservTarget === job.id
    ) {
      reservMode = false;
      reservTarget = null;
    }
  }

  // Apply results to state
  if (dispatched.size > 0) {
    // Remove dispatched jobs from queue
    const newQueue: Job[] = [];
    state.queueMap.clear();
    for (let i = 0; i < qLen; i++) {
      const j = queue[i];
      if (!dispatched.has(j.id)) {
        newQueue.push(j);
        state.queueMap.set(j.id, j);
      }
    }
    state.queue = newQueue;
    state.orgUsage = orgUsage;
    state.reservMode = reservMode;
    state.reservTarget = reservTarget;

    // Activate dispatched jobs
    for (let i = 0; i < qLen; i++) {
      const j = queue[i];
      if (!dispatched.has(j.id)) continue;
      const running: RunningJob = {
        ...j,
        startedAt: state.simTime,
        remainingDuration:
          j.estimatedDuration,
      };
      state.active.push(running);
      state.activeIds.add(j.id);
      state.activeMap.set(j.id, running);
      const pt = getJobPoolType(j, config);
      const fp = state.freeByPool[pt];
      if (fp) {
        fp.cpuMillis -= j.resources.cpuMillis;
        fp.memoryMiB -= j.resources.memoryMiB;
        fp.gpu -= j.resources.gpu;
      }
      eq.push({
        time:
          state.simTime +
          running.remainingDuration,
        type: 'JOB_COMPLETION',
        jobId: j.id,
      });
      const ev = ctx.jobEvents.get(j.id);
      if (ev) ev.startedAt = state.simTime;
    }
  } else {
    // No dispatches — just update scheduler
    // state without touching the queue array.
    state.reservMode = reservMode;
    state.reservTarget = reservTarget;
  }
};

/**
 * Process all events at the current timestamp
 * (batch), then run the scheduler once.
 * Returns false when there are no more events.
 *
 * Key optimization: if no capacity was freed in
 * this batch (only arrivals/TTL) AND the cluster
 * was already full, skip the expensive
 * runScheduler call entirely.
 */
const processBatch = (
  ctx: DESContext,
): boolean => {
  const {
    config,
    orgs,
    scoringFn,
    state,
    eq,
  } = ctx;

  if (eq.size === 0) return false;

  // Peek at the next timestamp
  const nextTime = eq.peek()!.time;
  if (nextTime > ctx.maxSimTime) return false;

  // Drain all events at this timestamp
  let needsSchedule = false;
  let capacityFreed = false;
  while (
    eq.size > 0 &&
    eq.peek()!.time === nextTime &&
    ctx.eventsProcessed < ctx.maxEvents
  ) {
    const r = applyEvent(ctx);
    if (r.changed) needsSchedule = true;
    if (r.capacityFreed) capacityFreed = true;
  }

  // Nothing changed or queue empty → done
  if (
    !needsSchedule ||
    state.queue.length === 0
  )
    return true;

  // Fast-path: if no capacity was freed (only
  // arrivals or TTL expiries), check if the
  // cluster has any room at all. If not, the
  // scheduler would score+sort 1000+ jobs only
  // to find nothing fits — skip entirely.
  // Uses incremental freeByPool — O(pools).
  if (!capacityFreed) {
    const minRes: Resources = {
      cpuMillis: 1000,
      memoryMiB: 1024,
      gpu: 0,
    };
    if (
      !hasAnyCapacityFast(
        state.freeByPool,
        minRes,
      )
    ) {
      if (
        state.simTime - ctx.lastUtilSample >=
        UTIL_SAMPLE_INTERVAL
      ) {
        sampleUtilization(ctx);
        ctx.lastUtilSample = state.simTime;
      }
      return true;
    }
  }

  // ── Bulk dispatch: score+sort ONCE, then
  // dispatch all fitting jobs in one pass. ──
  // This replaces the old loop that called
  // runScheduler repeatedly (re-scoring the
  // entire queue each time — O(D×N log N)).
  desBulkDispatch(ctx);

  // Sample utilization at intervals
  if (
    state.simTime - ctx.lastUtilSample >=
    UTIL_SAMPLE_INTERVAL
  ) {
    sampleUtilization(ctx);
    ctx.lastUtilSample = state.simTime;
  }

  return true;
};

/** Drain remaining active jobs after main loop */
const drainRemaining = (ctx: DESContext) => {
  const {
    maxSimTime,
    maxEvents,
    state,
    eq,
    jobEvents,
  } = ctx;
  while (
    eq.size > 0 &&
    ctx.eventsProcessed < maxEvents
  ) {
    const event = eq.peek()!;
    if (event.time > maxSimTime) break;
    eq.pop();
    ctx.eventsProcessed++;
    state.simTime = event.time;

    if (event.type === 'JOB_COMPLETION') {
      const jobId = event.jobId!;
      const job = state.activeMap.get(jobId);
      if (!job) continue;
      state.activeMap.delete(jobId);
      state.activeIds.delete(jobId);
      const ri = state.active.indexOf(job);
      if (ri >= 0) {
        const last =
          state.active[
            state.active.length - 1
          ];
        state.active[ri] = last;
        state.active.pop();
      }
      const poolType = getJobPoolType(
        job,
        ctx.config,
      );
      const orgPools =
        state.orgUsage[job.orgId];
      if (orgPools?.[poolType]) {
        const p = orgPools[poolType];
        orgPools[poolType] = {
          cpuMillis: p.cpuMillis - job.resources.cpuMillis,
          memoryMiB:
            p.memoryMiB - job.resources.memoryMiB,
          gpu: p.gpu - job.resources.gpu,
        };
      }
      const fp = state.freeByPool[poolType];
      if (fp) {
        fp.cpuMillis += job.resources.cpuMillis;
        fp.memoryMiB += job.resources.memoryMiB;
        fp.gpu += job.resources.gpu;
      }
      const ev = jobEvents.get(jobId);
      if (ev) ev.completedAt = state.simTime;
    } else if (event.type === 'TTL_EXPIRY') {
      const jobId = event.jobId!;
      const job = state.queueMap.get(jobId);
      if (!job) continue;
      const qi = state.queue.indexOf(job);
      if (qi >= 0) {
        const last =
          state.queue[
            state.queue.length - 1
          ];
        state.queue[qi] = last;
        state.queue.pop();
      }
      state.queueMap.delete(jobId);
      const ev = jobEvents.get(jobId);
      if (ev) ev.evictedAt = state.simTime;
    }
  }
  // Final utilization sample
  sampleUtilization(ctx);
};

const buildResult = (ctx: DESContext): DESResult => {
  const allEvents = Array.from(
    ctx.jobEvents.values(),
  );
  return {
    events: allEvents,
    utilSamples: ctx.utilSamples,
    simDuration: ctx.state.simTime,
    totalEventsProcessed: ctx.eventsProcessed,
    completedCount: allEvents.filter(
      (e) => e.completedAt !== null,
    ).length,
    evictedCount: allEvents.filter(
      (e) => e.evictedAt !== null,
    ).length,
  };
};

// ── DES Engine (synchronous — for workers) ──────────────────────────────

export const runDES = (
  desConfig: DESConfig,
): DESResult => {
  const ctx = initContext(desConfig);

  while (
    ctx.eq.size > 0 &&
    ctx.eventsProcessed < ctx.maxEvents
  ) {
    if (!processBatch(ctx)) break;
  }

  drainRemaining(ctx);
  return buildResult(ctx);
};

// ── DES Engine (async — yields to keep UI responsive) ───────────────────

/**
 * Yield to the browser via MessageChannel.
 * Unlike setTimeout, MessageChannel is NOT throttled
 * in background tabs (browsers throttle setTimeout
 * to ~1s in inactive tabs).
 */
const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });

/**
 * Async DES that yields every `yieldEvery` events
 * so the main-thread UI stays responsive.
 * Produces the same results as `runDES`.
 */
export const runDESAsync = async (
  desConfig: DESConfig,
  /** Yield every N batches (default 500) */
  yieldEvery = 500,
  /** Optional abort signal */
  signal?: AbortSignal,
): Promise<DESResult> => {
  const ctx = initContext(desConfig);
  let sinceYield = 0;

  while (
    ctx.eq.size > 0 &&
    ctx.eventsProcessed < ctx.maxEvents
  ) {
    if (signal?.aborted) {
      throw new DOMException(
        'DES run cancelled',
        'AbortError',
      );
    }
    if (!processBatch(ctx)) break;
    sinceYield++;
    if (sinceYield >= yieldEvery) {
      sinceYield = 0;
      await yieldToMain();
    }
  }

  drainRemaining(ctx);
  return buildResult(ctx);
};
