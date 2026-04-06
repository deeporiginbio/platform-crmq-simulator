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
  CompletedJob,
  EvictedJob,
  CRMQConfig,
  Org,
  OrgUsageMap,
  Resources,
  LogType,
} from '../types';
import { getJobPoolType } from '../types';
import {
  calcScore,
  runScheduler,
  completeJobs,
  evictExpired,
  zeroPoolUsage,
  newJobId,
  resetJobIdCounter,
  getAvailabilityPerPool,
  sumResources,
} from '../scheduler';
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
 * Priority queue for events, ordered by ascending time.
 * Simple sorted-insert for clarity; fine for our event volumes.
 */
class EventQueue {
  private events: SimEvent[] = [];

  push(event: SimEvent): void {
    // Binary search insertion to maintain sorted order
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].time <= event.time) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, event);
  }

  pop(): SimEvent | undefined {
    return this.events.shift();
  }

  peek(): SimEvent | undefined {
    return this.events[0];
  }

  get size(): number {
    return this.events.length;
  }

  /** Remove all events for a specific job (used when a job is evicted or completed) */
  removeForJob(jobId: string): void {
    this.events = this.events.filter(e => e.jobId !== jobId);
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
  orgUsage: OrgUsageMap;
  reservMode: boolean;
  reservTarget: string | null;
}

// ── DES Engine ────────────────────────────────────────────────────────────

export const runDES = (desConfig: DESConfig): DESResult => {
  const { config, orgs, workload } = desConfig;
  const maxSimTime = desConfig.maxSimTime ?? 86400; // 24 hours default
  const maxEvents = desConfig.maxEvents ?? 1_000_000;

  // Reset ID counters for clean run
  resetJobIdCounter();

  // Initialize state
  const state: EngineState = {
    simTime: 0,
    queue: [],
    active: [],
    orgUsage: Object.fromEntries(orgs.map(o => [o.id, zeroPoolUsage(config)])),
    reservMode: false,
    reservTarget: null,
  };

  // Output collectors
  const jobEvents: Map<string, JobEvent> = new Map();
  const utilSamples: UtilizationSample[] = [];

  // Build event queue
  const eq = new EventQueue();

  // Schedule all job arrivals
  for (const job of workload) {
    eq.push({
      time: job.arrivalTime,
      type: 'JOB_ARRIVAL',
      jobTemplate: job,
    });
  }

  let eventsProcessed = 0;

  // ── Utility: take utilization sample ──────────────────────────────────

  const sampleUtilization = () => {
    const pools: Record<string, { used: Resources; total: Resources }> = {};
    for (const pool of config.cluster.pools) {
      const poolJobs = state.active.filter(j => getJobPoolType(j, config) === pool.type);
      const used = poolJobs.reduce<Resources>(
        (acc, j) => ({ cpu: acc.cpu + j.resources.cpu, memory: acc.memory + j.resources.memory, gpu: acc.gpu + j.resources.gpu }),
        { cpu: 0, memory: 0, gpu: 0 },
      );
      pools[pool.type] = {
        used,
        total: {
          cpu: pool.total.cpu - pool.reserved.cpu,
          memory: pool.total.memory - pool.reserved.memory,
          gpu: pool.total.gpu - pool.reserved.gpu,
        },
      };
    }
    utilSamples.push({ time: state.simTime, pools });
  };

  // ── Main Event Loop ──────────────────────────────────────────────────

  while (eq.size > 0 && eventsProcessed < maxEvents) {
    const event = eq.pop()!;
    eventsProcessed++;

    // Safety: don't exceed max sim time
    if (event.time > maxSimTime) break;

    // Advance sim time
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
          estimatedDuration: tmpl.estimatedDuration,
          ttl: tmpl.ttl,
          enqueuedAt: state.simTime,
          skipCount: 0,
        };

        state.queue.push(job);

        // Record event
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
          estimatedDuration: job.estimatedDuration,
        });

        // Schedule TTL expiry event (skip if TTL is infinite — jobs never expire)
        if (isFinite(job.ttl)) {
          eq.push({
            time: state.simTime + job.ttl,
            type: 'TTL_EXPIRY',
            jobId: job.id,
          });
        }

        break;
      }

      case 'JOB_COMPLETION': {
        const jobId = event.jobId!;
        const runningIdx = state.active.findIndex(j => j.id === jobId);
        if (runningIdx === -1) break; // already handled

        const job = state.active[runningIdx];
        state.active.splice(runningIdx, 1);

        // Release resources from org usage
        const poolType = getJobPoolType(job, config);
        const orgPools = state.orgUsage[job.orgId];
        if (orgPools?.[poolType]) {
          const p = orgPools[poolType];
          orgPools[poolType] = {
            cpu: p.cpu - job.resources.cpu,
            memory: p.memory - job.resources.memory,
            gpu: p.gpu - job.resources.gpu,
          };
        }

        // Update event record
        const ev = jobEvents.get(jobId);
        if (ev) ev.completedAt = state.simTime;

        // Remove any lingering TTL event for this job
        eq.removeForJob(jobId);

        break;
      }

      case 'TTL_EXPIRY': {
        const jobId = event.jobId!;
        const queueIdx = state.queue.findIndex(j => j.id === jobId);
        if (queueIdx === -1) break; // already dispatched or evicted

        // Only evict if actually expired (check age)
        const job = state.queue[queueIdx];
        const age = state.simTime - job.enqueuedAt;
        if (age < job.ttl) break; // not yet expired (arrival of event was approximate)

        state.queue.splice(queueIdx, 1);

        const ev = jobEvents.get(jobId);
        if (ev) ev.evictedAt = state.simTime;

        // If reservation target was evicted, clear reservation
        if (state.reservMode && state.reservTarget === jobId) {
          state.reservMode = false;
          state.reservTarget = null;
        }

        break;
      }
    }

    // ── Try Scheduling ──────────────────────────────────────────────────
    // After every event, try to dispatch queued jobs.
    // Loop until no more dispatches happen (fill all available capacity).

    let dispatching = true;
    while (dispatching && state.queue.length > 0) {
      const result = runScheduler(
        state.queue,
        state.active,
        state.orgUsage,
        state.reservMode,
        state.reservTarget,
        state.simTime,
        config,
        orgs,
        undefined, // no logging in headless mode
        desConfig.scoringFn, // pluggable formula
      );

      state.queue = result.queue as Job[];
      state.reservMode = result.reservMode;
      state.reservTarget = result.reservTarget;

      // Detect newly dispatched jobs
      const newActive = result.active.filter(
        a => !state.active.some(sa => sa.id === a.id),
      );

      state.active = result.active;
      state.orgUsage = result.orgUsage;

      if (newActive.length === 0) {
        dispatching = false;
      } else {
        // Schedule completion events for newly dispatched jobs
        for (const job of newActive) {
          const completionTime = state.simTime + job.remainingDuration;
          eq.push({
            time: completionTime,
            type: 'JOB_COMPLETION',
            jobId: job.id,
          });

          // Update event record
          const ev = jobEvents.get(job.id);
          if (ev) ev.startedAt = state.simTime;

          // Remove TTL event since job is now running
          eq.removeForJob(job.id);
          // Re-add completion event (removeForJob removed it too)
          eq.push({
            time: completionTime,
            type: 'JOB_COMPLETION',
            jobId: job.id,
          });
        }
      }
    }

    // Sample utilization after state changes
    sampleUtilization();
  }

  // ── Drain remaining active jobs ─────────────────────────────────────
  // Process remaining completion events even if queue is empty
  while (eq.size > 0 && eventsProcessed < maxEvents) {
    const event = eq.pop()!;
    if (event.time > maxSimTime) break;
    eventsProcessed++;
    state.simTime = event.time;

    if (event.type === 'JOB_COMPLETION') {
      const jobId = event.jobId!;
      const runningIdx = state.active.findIndex(j => j.id === jobId);
      if (runningIdx >= 0) {
        const job = state.active[runningIdx];
        state.active.splice(runningIdx, 1);

        const poolType = getJobPoolType(job, config);
        const orgPools = state.orgUsage[job.orgId];
        if (orgPools?.[poolType]) {
          const p = orgPools[poolType];
          orgPools[poolType] = {
            cpu: p.cpu - job.resources.cpu,
            memory: p.memory - job.resources.memory,
            gpu: p.gpu - job.resources.gpu,
          };
        }

        const ev = jobEvents.get(jobId);
        if (ev) ev.completedAt = state.simTime;

        sampleUtilization();
      }
    } else if (event.type === 'TTL_EXPIRY') {
      const jobId = event.jobId!;
      const queueIdx = state.queue.findIndex(j => j.id === jobId);
      if (queueIdx >= 0) {
        state.queue.splice(queueIdx, 1);
        const ev = jobEvents.get(jobId);
        if (ev) ev.evictedAt = state.simTime;
        sampleUtilization();
      }
    }
  }

  // ── Build results ───────────────────────────────────────────────────

  const allEvents = Array.from(jobEvents.values());
  const completedCount = allEvents.filter(e => e.completedAt !== null).length;
  const evictedCount = allEvents.filter(e => e.evictedAt !== null).length;
  return {
    events: allEvents,
    utilSamples,
    simDuration: state.simTime,
    totalEventsProcessed: eventsProcessed,
    completedCount,
    evictedCount,
  };
};
