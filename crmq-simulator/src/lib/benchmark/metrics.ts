/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Metrics Collector
 * ====================================
 * Aggregates raw simulation events into the metrics recommended by §5.2
 * of the CRMQ Priority Queue Research Report.
 *
 * Pure functions — no side effects, no framework dependencies.
 *
 * Metrics implemented:
 *   Performance — P50/P95/P99 wait-time latency, throughput, mean/max wait
 *   Fairness    — Jain's Fairness Index, coefficient of variation, max/median ratio
 *   Utilization — per-pool CPU/GPU utilization %, resource fragmentation
 *   Cost        — cost-per-job (placeholder; requires cost model)
 */

import type { Resources, CRMQConfig, Org, OrgUsageMap } from '../types';

// ── Raw Event Types (what the DES engine records) ──────────────────────────

export interface JobEvent {
  jobId: string;
  jobName: string;
  orgId: string;
  resources: Resources;
  poolType: string;
  enqueuedAt: number;     // sim-time
  startedAt: number | null;
  completedAt: number | null;
  evictedAt: number | null;
  estimatedDuration: number;
}

/**
 * A resource utilization sample taken at a point in sim-time.
 * The DES engine emits one sample per event (dispatch, completion, eviction).
 */
export interface UtilizationSample {
  time: number;
  /** Per-pool: { [poolType]: { used: Resources; total: Resources } } */
  pools: Record<string, { used: Resources; total: Resources }>;
}

// ── Computed Metrics ───────────────────────────────────────────────────────

/** Full metrics output — matches the BenchmarkMetrics interface shape from config/types.ts
 *  but adds the extra fields recommended by §5.2. */
export interface ComputedMetrics {
  // Performance
  totalJobs: number;
  jobsCompleted: number;
  jobsEvicted: number;
  throughput: number;             // jobs completed per simulated minute
  meanWaitTime: number;
  maxWaitTime: number;
  p50WaitTime: number;
  p95WaitTime: number;
  p99WaitTime: number;

  // Fairness
  jainsIndex: number;             // Jain's Fairness Index (0–1)
  coefficientOfVariation: number; // std_dev / mean of wait times
  maxMedianWaitRatio: number;     // max_wait / median_wait

  // Utilization (per-pool, time-weighted)
  utilization: Record<string, { cpu: number; gpu: number; memory: number }>;
  resourceFragmentation: Record<string, number>;  // per-pool wasted % (0–1)

  // Cost (placeholder)
  costPerJob: number | null;

  // Per-org breakdown
  orgMetrics: Record<string, OrgMetrics>;

  // Eviction rate
  evictionRate: number;           // % of total jobs evicted (0–1)
}

export interface OrgMetrics {
  jobsSubmitted: number;
  jobsCompleted: number;
  jobsEvicted: number;
  meanWaitTime: number;
  p95WaitTime: number;
  /** Org's "dominant share" — max(dim_used / dim_total) across resource dims */
  dominantShare: number;
}

// ── Percentile Utility ────────────────────────────────────────────────────

/**
 * Compute a percentile from a sorted-ascending numeric array.
 * Uses linear interpolation (same method as numpy.percentile default).
 */
export const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

// ── Jain's Fairness Index ─────────────────────────────────────────────────

/**
 * J(x1, …, xn) = (Σxi)² / (n × Σxi²)
 * Range [1/n, 1]. Perfect fairness = 1.
 */
export const jainsIndex = (values: number[]): number => {
  const n = values.length;
  if (n === 0) return 1;
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  if (sumSq === 0) return 1; // all zero → perfectly fair
  return (sum * sum) / (n * sumSq);
};

// ── Time-Weighted Utilization ─────────────────────────────────────────────

interface PoolUtilResult {
  cpu: number;   // 0–1
  gpu: number;   // 0–1
  memory: number; // 0–1
  fragmentation: number; // 0–1
}

/**
 * Compute time-weighted utilization per pool from utilization samples.
 * Fragmentation = average of (1 - min(cpu_util, gpu_util, mem_util)) across
 * time, measuring wasted capacity due to dimensional imbalance.
 */
const computePoolUtilization = (
  samples: UtilizationSample[],
  poolType: string,
  simDuration: number,
): PoolUtilResult => {
  if (samples.length === 0 || simDuration <= 0) {
    return { cpu: 0, gpu: 0, memory: 0, fragmentation: 0 };
  }

  let weightedCpu = 0;
  let weightedGpu = 0;
  let weightedMem = 0;
  let weightedFrag = 0;
  let totalWeight = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const pool = s.pools[poolType];
    if (!pool) continue;

    // Duration until the next sample (or end of sim)
    const nextTime = i + 1 < samples.length ? samples[i + 1].time : simDuration;
    const dt = Math.max(0, nextTime - s.time);
    if (dt === 0) continue;

    const cpuUtil = pool.total.cpu > 0 ? pool.used.cpu / pool.total.cpu : 0;
    const gpuUtil = pool.total.gpu > 0 ? pool.used.gpu / pool.total.gpu : 0;
    const memUtil = pool.total.memory > 0 ? pool.used.memory / pool.total.memory : 0;

    // Fragmentation: highest utilized dimension minus lowest
    const dims = [cpuUtil, memUtil];
    if (pool.total.gpu > 0) dims.push(gpuUtil);
    const maxUtil = Math.max(...dims);
    const minUtil = Math.min(...dims);
    const frag = maxUtil > 0 ? (maxUtil - minUtil) / maxUtil : 0;

    weightedCpu += cpuUtil * dt;
    weightedGpu += gpuUtil * dt;
    weightedMem += memUtil * dt;
    weightedFrag += frag * dt;
    totalWeight += dt;
  }

  if (totalWeight === 0) return { cpu: 0, gpu: 0, memory: 0, fragmentation: 0 };

  return {
    cpu: weightedCpu / totalWeight,
    gpu: weightedGpu / totalWeight,
    memory: weightedMem / totalWeight,
    fragmentation: weightedFrag / totalWeight,
  };
};

// ── Main Metrics Computation ──────────────────────────────────────────────

export const computeMetrics = (
  events: JobEvent[],
  samples: UtilizationSample[],
  config: CRMQConfig,
  orgs: Org[],
  simDuration: number,
  warmUpTime: number = 0,
): ComputedMetrics => {
  // Safety cap: warm-up must never exceed 20% of total sim duration.
  // The auto-detection algorithm can misfire (e.g. detecting false steady-state during
  // the drain-down phase), producing warm-up values that filter out ALL observations.
  // This cap guarantees at least 80% of sim time contributes data.
  const maxWarmUp = simDuration * 0.20;
  const effectiveWarmUp = Math.min(warmUpTime, maxWarmUp);

  // Filter to output observations after warm-up.
  // Standard DES practice: discard observations whose *outcome* (completion/eviction)
  // occurred during warm-up — NOT arrivals. A job enqueued during warm-up but completing
  // in steady-state carries valid steady-state scheduling information.
  const completed = events.filter(
    e => e.completedAt !== null && e.startedAt !== null && e.completedAt >= effectiveWarmUp,
  );
  const evicted = events.filter(
    e => e.evictedAt !== null && e.evictedAt >= effectiveWarmUp,
  );
  // For total job count, include all jobs whose outcome was determined in steady state
  const postWarmUp = events.filter(e => {
    const outcomeTime = e.completedAt ?? e.evictedAt;
    return outcomeTime !== null && outcomeTime >= effectiveWarmUp;
  });
  // Also include still-queued jobs enqueued after warm-up (no outcome yet)
  const stillQueued = events.filter(
    e => e.completedAt === null && e.evictedAt === null && e.enqueuedAt >= effectiveWarmUp,
  );

  const waitTimes = completed
    .map(e => (e.startedAt! - e.enqueuedAt))
    .sort((a, b) => a - b);

  const totalJobs = postWarmUp.length + stillQueued.length;
  const jobsCompleted = completed.length;
  const jobsEvicted = evicted.length;

  // Performance
  const effectiveDuration = Math.max(1, simDuration - effectiveWarmUp);
  const throughput = jobsCompleted / (effectiveDuration / 60);
  const meanWaitTime = waitTimes.length > 0
    ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
    : 0;
  const maxWaitTime = waitTimes.length > 0 ? waitTimes[waitTimes.length - 1] : 0;
  const p50WaitTime = percentile(waitTimes, 50);
  const p95WaitTime = percentile(waitTimes, 95);
  const p99WaitTime = percentile(waitTimes, 99);

  // Fairness — Jain's index on per-org mean wait times
  const orgWaitMap: Record<string, number[]> = {};
  for (const e of completed) {
    if (!orgWaitMap[e.orgId]) orgWaitMap[e.orgId] = [];
    orgWaitMap[e.orgId].push(e.startedAt! - e.enqueuedAt);
  }
  const orgMeanWaits = Object.values(orgWaitMap).map(
    waits => waits.reduce((a, b) => a + b, 0) / waits.length,
  );
  const jfi = jainsIndex(orgMeanWaits);

  // CoV of wait times
  const stdDev = waitTimes.length > 1
    ? Math.sqrt(waitTimes.reduce((acc, w) => acc + (w - meanWaitTime) ** 2, 0) / (waitTimes.length - 1))
    : 0;
  const coefficientOfVariation = meanWaitTime > 0 ? stdDev / meanWaitTime : 0;

  // Max/Median ratio
  const medianWait = percentile(waitTimes, 50);
  const maxMedianWaitRatio = medianWait > 0 ? maxWaitTime / medianWait : 0;

  // Utilization (post warm-up samples only)
  const postWarmUpSamples = samples.filter(s => s.time >= effectiveWarmUp);
  const utilization: Record<string, { cpu: number; gpu: number; memory: number }> = {};
  const resourceFragmentation: Record<string, number> = {};

  for (const pool of config.cluster.pools) {
    const u = computePoolUtilization(postWarmUpSamples, pool.type, simDuration);
    utilization[pool.type] = { cpu: u.cpu, gpu: u.gpu, memory: u.memory };
    resourceFragmentation[pool.type] = u.fragmentation;
  }

  // Per-org metrics (using steady-state completed/evicted sets)
  const orgMetrics: Record<string, OrgMetrics> = {};
  for (const org of orgs) {
    const orgCompleted = completed.filter(e => e.orgId === org.id);
    const orgEvicted = evicted.filter(e => e.orgId === org.id);
    const orgWaits = orgCompleted
      .map(e => (e.startedAt! - e.enqueuedAt))
      .sort((a, b) => a - b);

    orgMetrics[org.id] = {
      jobsSubmitted: orgCompleted.length + orgEvicted.length,
      jobsCompleted: orgCompleted.length,
      jobsEvicted: orgEvicted.length,
      meanWaitTime: orgWaits.length > 0
        ? orgWaits.reduce((a, b) => a + b, 0) / orgWaits.length
        : 0,
      p95WaitTime: percentile(orgWaits, 95),
      dominantShare: 0, // computed per-snapshot in DES engine, averaged here
    };
  }

  return {
    totalJobs,
    jobsCompleted,
    jobsEvicted,
    throughput,
    meanWaitTime,
    maxWaitTime,
    p50WaitTime,
    p95WaitTime,
    p99WaitTime,
    jainsIndex: jfi,
    coefficientOfVariation,
    maxMedianWaitRatio,
    utilization,
    resourceFragmentation,
    costPerJob: null,  // placeholder — requires cost model
    orgMetrics,
    evictionRate: totalJobs > 0 ? jobsEvicted / totalJobs : 0,
  };
};
