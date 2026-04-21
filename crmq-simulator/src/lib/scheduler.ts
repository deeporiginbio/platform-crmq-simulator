/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Scheduler — Core Scheduling Engine
 * =========================================
 * Implements the Priority Queue scheduling logic from the CRMQ design doc (§3).
 *
 * Pure logic — no UI, no DOM, no framework dependencies.
 */

import {
  type Resources,
  type ResourcesByType,
  type Org,
  type Job,
  type ScoredJob,
  type RunningJob,
  type CompletedJob,
  type EvictedJob,
  type CRMQConfig,
  type ScoringConfig,
  type SchedulerConfig,
  type ResourcePool,
  type OrgUsageMap,
  type SchedulerResult,
  type CompletionResult,
  type EvictionResult,
  type LogType,
  jobPools,
  jobResInPool,
  jobTotalResources,
} from './types';
import { createScoreFn } from './benchmark/scoring';
import { normalizeFormulaType } from './config/formulas/registry';
import {
  cpuMillisFromVcpu,
  memoryMiBFromGb,
  vcpuFromCpuMillis,
  gbFromMemoryMiB,
} from './units';

// ── Default Configuration ────────────────────────────────────────────────────

/**
 * Default configuration based on real dev cluster data from
 * DeepOrigin Cluster us-west-2 (AWS account 992382738817).
 *
 * Account quotas (from GET /admin/resources/quotas):
 *   mason (L-1216C47A):    1,364 cores / 5,457 GB / 0 GPU, reserved: 1.5c / 1.5GB
 *   mason-gpu (L-DB2E81BA): 768 cores / 3,072 GB / 192 GPU, reserved: 0.5c / 0.5GB
 */
export const DEFAULT_CONFIG: CRMQConfig = {
  scoring: {
    orgWeight:    10_000,
    userWeight:    1_000,
    toolWeight:      100,
    agingFactor:       5,
  },
  scheduler: {
    topN:                        10,
    // Retained for diagnostics only; reservation activation is wall-clock driven.
    skipThreshold:                3,
    // Platform parity: 20s cron × 30 skips = 600s wall-clock before reservation.
    reservationThresholdSec:    600,
    backfillMaxRatio:           0.5,
  },
  cluster: {
    pools: [
      {
        type: 'mason',
        label: 'CPU Pool (mason)',
        shortLabel: 'CPU',
        color: '#4A65DC',
        quotaType: 'cpu',
        // 1,364 vCPU / 5,457 GB
        total: {
          cpuMillis: cpuMillisFromVcpu(1364),
          memoryMiB: memoryMiBFromGb(5457),
          gpu: 0,
        },
        // 2 vCPU / 2 GB reserved for system overhead
        reserved: {
          cpuMillis: cpuMillisFromVcpu(2),
          memoryMiB: memoryMiBFromGb(2),
          gpu: 0,
        },
        // Non-CRMQ tenants sharing the pool (platform: externalUsage). Zero by default.
        externalUsage: {
          cpuMillis: 0,
          memoryMiB: 0,
          gpu: 0,
        },
        routeWhen: (res) => res.gpu === 0,
      },
      {
        type: 'mason-gpu',
        label: 'GPU Pool (mason-gpu)',
        shortLabel: 'GPU',
        color: '#11A468',
        quotaType: 'gpu',
        // 768 vCPU / 3,072 GB / 192 GPU
        total: {
          cpuMillis: cpuMillisFromVcpu(768),
          memoryMiB: memoryMiBFromGb(3072),
          gpu: 192,
        },
        // 1 vCPU / 1 GB reserved for system overhead
        reserved: {
          cpuMillis: cpuMillisFromVcpu(1),
          memoryMiB: memoryMiBFromGb(1),
          gpu: 0,
        },
        // Non-CRMQ tenants sharing the pool (platform: externalUsage). Zero by default.
        externalUsage: {
          cpuMillis: 0,
          memoryMiB: 0,
          gpu: 0,
        },
        routeWhen: (res) => res.gpu > 0,
      },
    ],
  },
  ttlDefault: Infinity,
  formulaType: 'balanced_composite',
};

/**
 * Seed orgs. `limits[poolType]` is a **percentage** of the pool's total
 * capacity in [0, 100] — platform parity. Missing pool key ⇒ no quota row
 * for that pool (treated as unlimited up to pool capacity).
 *
 * Percentages chosen to mirror the prior absolute seeds against DEFAULT_CONFIG
 * pool totals:
 *   mason     total = 1364 vCPU / 5457 GB
 *   mason-gpu total = 768 vCPU / 3072 GB / 192 GPU
 * deeporigin = 100% of both pools (big customer, full nominal quota).
 * org-beta / org-gamma = 28% mason (≈384/1364), 25% mason-gpu (192/768 = 48/192).
 * Oversubscription (Σ > 100%) is intentional and matches real platform usage.
 */
export const DEFAULT_ORGS: Org[] = [
  {
    id: 'deeporigin', name: 'Deeporigin', priority: 3,
    limits: { mason: 100, 'mason-gpu': 100 },
  },
  {
    id: 'org-beta', name: 'Partner Org', priority: 2,
    limits: { mason: 28, 'mason-gpu': 25 },
  },
  {
    id: 'org-gamma', name: 'Research Lab', priority: 1,
    limits: { mason: 28, 'mason-gpu': 25 },
  },
];

/**
 * Shorthand helpers for PRESET_JOBS.
 *
 * - `cpuReq(vcpu, gb)` → ResourcesByType keyed to `mason` (CPU-only pool).
 * - `gpuReq(vcpu, gb, gpu)` → ResourcesByType keyed to `mason-gpu`.
 * - `multiReq([...])` → merge several single-pool slices into a multi-pool
 *   request (for jobs that straddle `mason` + `mason-gpu` concurrently, §1.4).
 *
 * These keep the fixture table readable in UI units (vCPU + GB).
 */
const cpuReq = (vcpu: number, gb: number): ResourcesByType => ({
  mason: {
    cpuMillis: cpuMillisFromVcpu(vcpu),
    memoryMiB: memoryMiBFromGb(gb),
    gpu: 0,
  },
});

const gpuReq = (vcpu: number, gb: number, gpu: number): ResourcesByType => ({
  'mason-gpu': {
    cpuMillis: cpuMillisFromVcpu(vcpu),
    memoryMiB: memoryMiBFromGb(gb),
    gpu,
  },
});

const multiReq = (slices: ResourcesByType[]): ResourcesByType =>
  Object.assign({}, ...slices);

export const PRESET_JOBS: Omit<Job, 'id' | 'enqueuedAt' | 'skipCount'>[] = [
  { name: 'Ligand Prep',         orgId: 'deeporigin', userPriority: 3, toolPriority: 2, resources: cpuReq(  4,  16),    estimatedDuration:  45, ttl: Infinity },
  { name: 'GPU Docking (large)', orgId: 'deeporigin', userPriority: 5, toolPriority: 4, resources: gpuReq(  8,  32, 4), estimatedDuration: 120, ttl: Infinity },
  { name: 'Data Ingestion',      orgId: 'org-beta',   userPriority: 2, toolPriority: 1, resources: cpuReq(  2,   8),    estimatedDuration:  30, ttl: Infinity },
  { name: 'ML Training',         orgId: 'org-beta',   userPriority: 4, toolPriority: 3, resources: gpuReq( 16,  64, 2), estimatedDuration: 180, ttl: Infinity },
  { name: 'API Serving',         orgId: 'org-gamma',  userPriority: 5, toolPriority: 5, resources: cpuReq(  4,  16),    estimatedDuration:  60, ttl: Infinity },
  { name: 'Pocket Finding',      orgId: 'org-gamma',  userPriority: 3, toolPriority: 2, resources: gpuReq(  8,  32, 2), estimatedDuration:  90, ttl: Infinity },
  { name: 'Parallel Docking ×4', orgId: 'deeporigin', userPriority: 4, toolPriority: 3, resources: gpuReq( 32, 128, 8), estimatedDuration: 200, ttl: Infinity },
  { name: 'Quick Analysis',      orgId: 'org-beta',   userPriority: 2, toolPriority: 1, resources: cpuReq(  2,   4),    estimatedDuration:  15, ttl: Infinity },
  // §1.4 multi-pool example: a hybrid CPU+GPU workflow that holds capacity
  // in both pools simultaneously (e.g. CPU-side data prep pipelined with
  // GPU-side inference). Exercises the cpuMillis-weighted load-ratio path.
  {
    name: 'Hybrid ML Pipeline',
    orgId: 'deeporigin',
    userPriority: 4,
    toolPriority: 3,
    resources: multiReq([cpuReq(8, 32), gpuReq(8, 32, 2)]),
    estimatedDuration: 150,
    ttl: Infinity,
  },
];


// ── Resource Math ────────────────────────────────────────────────────────────

export const ZERO: Readonly<Resources> = Object.freeze({
  cpuMillis: 0,
  memoryMiB: 0,
  gpu: 0,
});

/**
 * Sentinel "effectively no limit" value used when an org has no quota row
 * for a given pool. Large but finite so arithmetic stays safe.
 */
export const UNLIMITED_RES: Readonly<Resources> = Object.freeze({
  cpuMillis: Number.MAX_SAFE_INTEGER,
  memoryMiB: Number.MAX_SAFE_INTEGER,
  gpu: Number.MAX_SAFE_INTEGER,
});

/**
 * Resolve an org's per-pool quota to absolute Resources.
 *
 * `org.limits[poolType]` is a single percentage in [0, 100] applied uniformly
 * to all resource dimensions of `pool.total`. When the org has no row for
 * this pool, or the pool is not found, returns UNLIMITED_RES (sentinel).
 *
 * Uses `pool.total` as the denominator (not `total − reserved`); `reserved`
 * is system overhead and is subtracted separately by Gate 2 (pool capacity).
 */
export const resolveOrgPoolCap = (
  org: Org | undefined,
  poolType: string,
  pool: ResourcePool | undefined,
): Resources => {
  if (!org || !pool) return { ...UNLIMITED_RES };
  const pct = org.limits[poolType];
  if (pct === undefined) return { ...UNLIMITED_RES };
  const p = Math.max(0, Math.min(100, pct)) / 100;
  return {
    cpuMillis: Math.floor(pool.total.cpuMillis * p),
    memoryMiB: Math.floor(pool.total.memoryMiB * p),
    gpu: Math.floor(pool.total.gpu * p),
  };
};

/** Build a frozen zero-usage record for the given config's pools */
export const buildZeroPoolUsage = (
  config: CRMQConfig,
): Readonly<Record<string, Resources>> => {
  const result: Record<string, Resources> = {};
  for (const pool of config.cluster.pools) {
    result[pool.type] = Object.freeze({ cpuMillis: 0, memoryMiB: 0, gpu: 0 });
  }
  return Object.freeze(result);
};

export const add3 = (a: Resources, b: Resources): Resources => {
  return {
    cpuMillis: a.cpuMillis + b.cpuMillis,
    memoryMiB: a.memoryMiB + b.memoryMiB,
    gpu: a.gpu + b.gpu,
  };
};

export const sub3 = (a: Resources, b: Resources): Resources => {
  return {
    cpuMillis: a.cpuMillis - b.cpuMillis,
    memoryMiB: a.memoryMiB - b.memoryMiB,
    gpu: a.gpu - b.gpu,
  };
};

export const fits = (req: Resources, avail: Resources): boolean => {
  return (
    req.cpuMillis <= avail.cpuMillis &&
    req.memoryMiB <= avail.memoryMiB &&
    req.gpu <= avail.gpu
  );
};

/**
 * Sum resource slices at a given pool across a set of jobs.
 * Multi-pool jobs contribute only their slice for `poolType`. Jobs that
 * don't touch the pool contribute zero.
 */
export const sumResourcesInPool = (
  jobs: Array<{ resources: ResourcesByType }>,
  poolType: string,
): Resources => {
  let cpuMillis = 0;
  let memoryMiB = 0;
  let gpu = 0;
  for (const j of jobs) {
    const slice = j.resources[poolType];
    if (!slice) continue;
    cpuMillis += slice.cpuMillis;
    memoryMiB += slice.memoryMiB;
    gpu += slice.gpu;
  }
  return { cpuMillis, memoryMiB, gpu };
};

/**
 * Sum resources across all pools a set of jobs touches. Useful for
 * aggregate utilization sampling (total CPU/mem/GPU in flight regardless
 * of pool). For per-pool accounting, use `sumResourcesInPool`.
 */
export const sumAllJobResources = (
  jobs: Array<{ resources: ResourcesByType }>,
): Resources => {
  let cpuMillis = 0;
  let memoryMiB = 0;
  let gpu = 0;
  for (const j of jobs) {
    const total = jobTotalResources(j);
    cpuMillis += total.cpuMillis;
    memoryMiB += total.memoryMiB;
    gpu += total.gpu;
  }
  return { cpuMillis, memoryMiB, gpu };
};

export const cloneZero = (): Resources => {
  return { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
};

/** Create a mutable zero per-pool usage record from config */
export const zeroPoolUsage = (config: CRMQConfig): Record<string, Resources> => {
  const result: Record<string, Resources> = {};
  for (const pool of config.cluster.pools) {
    result[pool.type] = cloneZero();
  }
  return result;
};


// ── Priority Scoring (§3.1) ─────────────────────────────────────────────────

export const calcScore = (job: Job, now: number, config: CRMQConfig, orgs: Org[], orgUsage?: OrgUsageMap): number => {
  const formulaType = normalizeFormulaType(config.formulaType ?? 'balanced_composite');

  // For current_weighted, use the inline production formula for backward compat
  if (formulaType === 'current_weighted') {
    const org = orgs.find(o => o.id === job.orgId) ?? { priority: 3 };
    const wait = Math.max(0, now - job.enqueuedAt);
    const s = config.scoring;
    return (
      org.priority       * s.orgWeight  +
      job.userPriority   * s.userWeight +
      job.toolPriority   * s.toolWeight +
      wait               * s.agingFactor
    );
  }

  // For all other formulas, delegate to the benchmark scoring registry
  // Pass orgUsage so DRF, CFS, and Balanced Composite can access org resource state
  const scoreFn = createScoreFn(formulaType);
  return scoreFn(job, now, config, orgs, orgUsage);
};


// ── Pool Management ──────────────────────────────────────────────────────────

export const getPool = (config: CRMQConfig, poolType: string): ResourcePool => {
  const pool = config.cluster.pools.find(p => p.type === poolType);
  if (!pool) throw new Error(`Pool ${poolType} not found in cluster config`);
  return pool;
};

/**
 * Pool-local effective total (no account-level coupling applied).
 *
 * Platform parity: `availableDimension(total, externalUsage, reserved)` — the
 * effective capacity pool that CRMQ can dispatch into, before subtracting
 * CRMQ's own in-flight jobs. See
 *   platform/apps/tools-service/.../balanced-composite-scoring.strategy.ts
 *
 * When a pool is coupled via `accountResourceId`, prefer
 * `getPoolEffectiveCap(config, activeJobs, poolType)` — that variant folds
 * in the shared ceiling.
 */
export const poolEffectiveTotal = (pool: ResourcePool): Resources => {
  const externalUsage = pool.externalUsage ?? { ...ZERO };
  return {
    cpuMillis: Math.max(0, pool.total.cpuMillis - externalUsage.cpuMillis - pool.reserved.cpuMillis),
    memoryMiB: Math.max(0, pool.total.memoryMiB - externalUsage.memoryMiB - pool.reserved.memoryMiB),
    gpu:       Math.max(0, pool.total.gpu       - externalUsage.gpu       - pool.reserved.gpu),
  };
};

/**
 * Effective total capacity of a pool for dispatch/scoring denominators,
 * accounting for §3.4 shared account-resource coupling.
 *
 * - Local bound: `pool.total − externalUsage − reserved`.
 * - Coupled bound (when `pool.accountResourceId` set): the account
 *   resource's `totalCapacity − externalUsage − Σ(usage in sibling pools
 *   sharing the same accountResourceId, excluding this pool)`.
 * - Effective cap = min(local, coupled) per-dimension.
 *
 * This returns the *total* ceiling (not remaining availability). Subtract
 * the pool's own CRMQ usage from this to get headroom.
 */
export const getPoolEffectiveCap = (
  config: CRMQConfig,
  activeJobs: RunningJob[],
  poolType: string,
): Resources => {
  const pool = getPool(config, poolType);
  const local = poolEffectiveTotal(pool);
  const arId = pool.accountResourceId;
  if (!arId) return local;

  const ar = config.accountResources?.find(a => a.id === arId);
  if (!ar) return local; // misconfigured — fall back to local bound

  // Aggregate live usage in sibling pools that share this account resource,
  // excluding this pool itself. This pool's own usage is NOT subtracted
  // from the ceiling — the availability layer does that.
  const siblings = config.cluster.pools.filter(
    p => p.accountResourceId === arId && p.type !== poolType,
  );
  let sibCpu = 0, sibMem = 0, sibGpu = 0;
  for (const s of siblings) {
    const u = sumResourcesInPool(activeJobs, s.type);
    sibCpu += u.cpuMillis;
    sibMem += u.memoryMiB;
    sibGpu += u.gpu;
  }

  const arExt = ar.externalUsage ?? { ...ZERO };
  const accountHeadroom: Resources = {
    cpuMillis: Math.max(0, ar.totalCapacity.cpuMillis - arExt.cpuMillis - sibCpu),
    memoryMiB: Math.max(0, ar.totalCapacity.memoryMiB - arExt.memoryMiB - sibMem),
    gpu:       Math.max(0, ar.totalCapacity.gpu       - arExt.gpu       - sibGpu),
  };

  return {
    cpuMillis: Math.min(local.cpuMillis, accountHeadroom.cpuMillis),
    memoryMiB: Math.min(local.memoryMiB, accountHeadroom.memoryMiB),
    gpu:       Math.min(local.gpu,       accountHeadroom.gpu),
  };
};

export const getPoolAvailability = (
  config: CRMQConfig,
  activeJobs: RunningJob[],
  poolType: string,
): Resources => {
  // Multi-pool jobs contribute only their slice for this pool type.
  const inUse = sumResourcesInPool(activeJobs, poolType);
  // Platform parity: effective capacity (with §3.4 coupling) − CRMQ in-flight.
  return sub3(getPoolEffectiveCap(config, activeJobs, poolType), inUse);
};

export const getAvailabilityPerPool = (
  config: CRMQConfig,
  activeJobs: RunningJob[],
): Record<string, Resources> => {
  const result: Record<string, Resources> = {};
  for (const pool of config.cluster.pools) {
    result[pool.type] = getPoolAvailability(config, activeJobs, pool.type);
  }
  return result;
};

// ── Cluster Availability (aggregate across pools) ──────────────────────────

export const getAvailability = (config: CRMQConfig, activeJobs: RunningJob[]): Resources => {
  const availPerPool = getAvailabilityPerPool(config, activeJobs);
  return Object.values(availPerPool).reduce<Resources>(
    (acc, r) => add3(acc, r),
    { ...ZERO },
  );
};


// ── TTL Eviction (§1.2) ─────────────────────────────────────────────────────

export const evictExpired = (
  queue: Job[],
  now: number,
  logFn?: (time: number, msg: string, type: LogType) => void,
): EvictionResult => {
  const live: Job[] = [];
  const evicted: EvictedJob[] = [];

  for (const j of queue) {
    const age = now - j.enqueuedAt;
    if (age >= j.ttl) {
      evicted.push({ ...j, evictedAt: now });
      logFn?.(now, `⏰ TTL EVICT | ${j.name} [${j.id}] — waited ${fmtTime(age)}, TTL was ${fmtTime(j.ttl)}`, 'error');
    } else {
      live.push(j);
    }
  }

  return { live, evicted };
};


// ── Complete Finished Jobs ───────────────────────────────────────────────────

export const completeJobs = (
  activeJobs: RunningJob[],
  dt: number,
  now: number,
  orgUsage: OrgUsageMap,
  config: CRMQConfig,
  logFn?: (time: number, msg: string, type: LogType) => void,
): CompletionResult => {
  const stillRunning: RunningJob[] = [];
  const completed: CompletedJob[] = [];
  const updOrgUsage = shallowCloneOrgUsage(orgUsage);

  for (const j of activeJobs) {
    const rem = j.remainingDuration - dt;
    if (rem <= 0) {
      completed.push({ ...j, completedAt: now });
      // Release each pool slice the job was holding (multi-pool aware).
      const orgPools = updOrgUsage[j.orgId] ?? zeroPoolUsage(config);
      for (const poolType of jobPools(j)) {
        const slice = jobResInPool(j, poolType);
        orgPools[poolType] = sub3(orgPools[poolType] ?? cloneZero(), slice);
      }
      updOrgUsage[j.orgId] = orgPools;
      logFn?.(now, `🏁 COMPLETE | ${j.name} [${j.id}] — ran ${fmtTime(j.estimatedDuration)}, resources released`, 'success');
    } else {
      stillRunning.push({ ...j, remainingDuration: rem });
    }
  }

  return { stillRunning, completed, orgUsage: updOrgUsage };
};


// ── Scheduling Strategy (§3.2 / §3.3 / §3.4) ───────────────────────────────

export const runScheduler = (
  queue: Job[],
  active: RunningJob[],
  orgUsage: OrgUsageMap,
  reservMode: boolean,
  reservTarget: string | null,
  now: number,
  config: CRMQConfig,
  orgs: Org[],
  logFn?: (time: number, msg: string, type: LogType) => void,
  /** Optional custom scoring function — if provided, used instead of calcScore.
   *  Signature: (job, now, config, orgs, orgUsage?) => number */
  customScoreFn?: (job: Job, now: number, config: CRMQConfig, orgs: Org[], orgUsage?: OrgUsageMap) => number,
): SchedulerResult => {
  const sch = config.scheduler;

  // Build per-pool availability map
  let availByPool: Record<string, Resources> = getAvailabilityPerPool(config, active);

  // Score and rank — use custom scorer if provided
  // Both paths forward orgUsage so DRF/CFS/Balanced Composite formulas can access org resource state
  const scoreFn = customScoreFn
    ? (j: Job) => customScoreFn(j, now, config, orgs, orgUsage)
    : (j: Job) => calcScore(j, now, config, orgs, orgUsage);
  const ranked: ScoredJob[] = queue
    .map(j => ({ ...j, _score: scoreFn(j) }))
    .sort((a, b) => b._score - a._score);

  let topN = ranked.slice(0, sch.topN);

  // §3.4 Fix: Always include the reservation target in the candidate set.
  // Resource-aware formulas (DRF, CFS, Balanced Composite) rebalance scores
  // as org usage changes. This can cause the reservation target to drop below
  // the top-N threshold, creating a permanent deadlock where:
  //   - All top-N jobs are skipped (not the reservation target)
  //   - The reservation target is never attempted (not in top-N)
  //   - Nothing dispatches, ever
  if (reservMode && reservTarget) {
    const targetInTopN = topN.some(j => j.id === reservTarget);
    if (!targetInTopN) {
      const target = ranked.find(j => j.id === reservTarget);
      if (target) {
        topN = [...topN, target];
      }
    }
  }

  let nq: ScoredJob[] = [...ranked];
  let na: RunningJob[] = [...active];
  let no: OrgUsageMap = shallowCloneOrgUsage(orgUsage);
  let nr = reservMode;
  let nt = reservTarget;

  // Validate reservation target still exists
  if (nr && nt && !nq.find(j => j.id === nt)) {
    nr = false; nt = null;
    logFn?.(now, '🔓 Reservation mode lifted — target no longer in queue', 'info');
  }

  let dispatchedCount = 0;

  // Multi-pool quota check (§1.4 platform parity): a job clears Gate 1 only
  // if, in every pool it requests from, the org's resolved quota has room
  // for that pool slice. All-or-nothing — partial admission is not allowed.
  const quotaPasses = (j: Job, currentOrgUsage: OrgUsageMap): boolean => {
    const org = orgs.find(o => o.id === j.orgId);
    const orgPools = currentOrgUsage[j.orgId] ?? zeroPoolUsage(config);
    for (const poolType of jobPools(j)) {
      const pool = config.cluster.pools.find(p => p.type === poolType);
      const limits = resolveOrgPoolCap(org, poolType, pool);
      const used = orgPools[poolType] ?? cloneZero();
      const req = jobResInPool(j, poolType);
      if (
        used.cpuMillis + req.cpuMillis > limits.cpuMillis ||
        used.memoryMiB + req.memoryMiB > limits.memoryMiB ||
        used.gpu       + req.gpu       > limits.gpu
      ) {
        return false;
      }
    }
    return true;
  };

  // Multi-pool capacity check: every requested pool must fit simultaneously.
  const capacityPasses = (j: Job, avail: Record<string, Resources>): boolean => {
    for (const poolType of jobPools(j)) {
      const a = avail[poolType];
      if (!a) return false;
      if (!fits(jobResInPool(j, poolType), a)) return false;
    }
    return true;
  };

  // Admit a job: subtract its per-pool slices from availability and add to
  // the org's per-pool usage. Returns updated state.
  const admit = (
    j: ScoredJob,
    avail: Record<string, Resources>,
    usage: OrgUsageMap,
  ): { avail: Record<string, Resources>; usage: OrgUsageMap } => {
    const newAvail = { ...avail };
    const orgPools = { ...(usage[j.orgId] ?? zeroPoolUsage(config)) };
    for (const poolType of jobPools(j)) {
      const slice = jobResInPool(j, poolType);
      newAvail[poolType] = sub3(newAvail[poolType], slice);
      orgPools[poolType] = add3(orgPools[poolType] ?? cloneZero(), slice);
    }
    return { avail: newAvail, usage: { ...usage, [j.orgId]: orgPools } };
  };

  // §3.2 / §3.4 platform parity: attempt every topN candidate this tick, in
  // score order. Each admission decrements availByPool so subsequent
  // candidates see real residual capacity. Jobs that fail a gate are left
  // in the queue with their skipCount / firstGatedAt bookkeeping updated;
  // we do NOT early-exit after the first successful dispatch.
  for (const job of topN) {
    const org = orgs.find(o => o.id === job.orgId);
    const pools = jobPools(job);
    const primaryPool = pools[0] ?? 'unknown';

    // Gate 1: Org Quota (per-pool, resolved from percentage × pool.total)
    if (!quotaPasses(job, no)) {
      logFn?.(
        now,
        `⛔ Gate 1 FAIL | ${job.name} [${job.id}] — ${org?.name ?? job.orgId} quota exceeded across [${pools.join(', ')}] (SKIP)`,
        'warn',
      );
      nq = nq.map(j => j.id === job.id ? { ...j, skipCount: (j.skipCount || 0) + 1 } : j);
      continue;
    }

    // Reservation mode gate
    if (nr && nt && job.id !== nt) {
      logFn?.(now, `🔒 Reservation mode | blocking ${job.name} [${job.id}] — reserving for ${nt}`, 'warn');
      continue;
    }

    // Gate 2: Pool Capacity — multi-pool jobs require ALL slices to fit.
    const capOk = capacityPasses(job, availByPool);
    if (!capOk) {
      const newSkip = (job.skipCount || 0) + 1;
      // §3.4 wall-clock reservation trigger (platform parity: 600s default).
      // `firstGatedAt` captures the first sim-time at which this job was
      // capacity-gated and survives across ticks; reservation mode engages
      // once the job has been gated for `reservationThresholdSec` seconds.
      const firstGatedAt = job.firstGatedAt ?? now;
      const gatedFor = now - firstGatedAt;
      nq = nq.map(j => j.id === job.id ? { ...j, skipCount: newSkip, firstGatedAt } : j);
      logFn?.(
        now,
        `⛔ Gate 2 FAIL | ${job.name} [${job.id}] — capacity insufficient in [${pools.join(', ')}]. ` +
        `gated_for=${fmtTime(gatedFor)}/${fmtTime(sch.reservationThresholdSec)} (skip_count=${newSkip})`,
        'warn',
      );

      // §3.4 Large Task Guarantees — wall-clock, not skip-count.
      if (gatedFor >= sch.reservationThresholdSec && !nr) {
        nr = true; nt = job.id;
        logFn?.(
          now,
          `🔒 RESERVATION MODE ON | ${job.name} [${job.id}] capacity-gated for ` +
          `${fmtTime(gatedFor)} ≥ threshold ${fmtTime(sch.reservationThresholdSec)} ` +
          `— blocking new dispatches`,
          'error',
        );
      }

      // §3.3 Backfilling
      // Allow backfilling when:
      //   (a) The top-ranked job is blocked and we're NOT in reservation mode (original), OR
      //   (b) The reservation target itself is blocked (prevents cluster drain).
      // Without (b), reservation mode blocks ALL dispatches including small jobs that
      // would fill gaps, causing the cluster to drain to zero utilization while waiting
      // for the large reservation target to fit.
      const isBlockedTopJob = job.id === topN[0]?.id && !nr;
      const isBlockedReservTarget = nr && nt && job.id === nt;
      if (isBlockedTopJob || isBlockedReservTarget) {
        // In reservation mode, the target's score may have dropped due to
        // resource-aware rebalancing, so most jobs could have higher scores.
        // Skip the score filter for reservation backfills — any short job that
        // fits is a valid candidate to keep utilization up while we wait.
        const candidates = ranked
          .filter(j => j.id !== job.id && (isBlockedReservTarget || j._score < job._score))
          .filter(j => capacityPasses(j, availByPool))
          .filter(j => j.estimatedDuration <= job.estimatedDuration * sch.backfillMaxRatio);

        for (const bf of candidates) {
          // Capacity and quota may have shifted after admitting earlier
          // backfills this tick — re-check both against current state.
          if (!quotaPasses(bf, no) || !capacityPasses(bf, availByPool)) continue;

          na = [...na, { ...bf, startedAt: now, remainingDuration: bf.estimatedDuration }];
          nq = nq.filter(j => j.id !== bf.id);
          const admitted = admit(bf, availByPool, no);
          availByPool = admitted.avail;
          no = admitted.usage;
          logFn?.(
            now,
            `🔀 BACKFILL | ${bf.name} [${bf.id}] → [${jobPools(bf).join(', ')}] — fits gap, dur ${fmtTime(bf.estimatedDuration)} ≤ ${sch.backfillMaxRatio * 100}% of blocked`,
            'success',
          );
          dispatchedCount += 1;
          // Allow multiple backfills per blocked top-N job — each helps
          // keep utilization up while we wait for the blocker to fit.
        }
      }
      continue;
    }

    // ✅ DISPATCH
    const wait = now - job.enqueuedAt;
    // Log in UI units (vCPU + GB) across all requested pools.
    const totals = jobTotalResources(job);
    const vcpu = vcpuFromCpuMillis(totals.cpuMillis);
    const gb = gbFromMemoryMiB(totals.memoryMiB);
    const routeLabel = pools.length === 1 ? primaryPool : `[${pools.join('+')}]`;
    logFn?.(
      now,
      `✅ DISPATCH | ${job.name} [${job.id}] → ${routeLabel} — score=${Math.round(job._score).toLocaleString()}, wait=${fmtTime(wait)}, CPU:${vcpu} MEM:${gb}GB GPU:${totals.gpu}`,
      'success',
    );

    // Dispatching removes the job from the queue; `firstGatedAt` tracking
    // is implicitly cleared because we filter the job out of `nq` here.
    na = [...na, { ...job, startedAt: now, remainingDuration: job.estimatedDuration }];
    nq = nq.filter(j => j.id !== job.id);
    const admitted = admit(job, availByPool, no);
    availByPool = admitted.avail;
    no = admitted.usage;

    if (nr && nt === job.id) {
      nr = false; nt = null;
      logFn?.(now, '🔓 Reservation mode cleared — target dispatched', 'info');
    }
    dispatchedCount += 1;
  }

  return {
    queue: nq,
    active: na,
    orgUsage: no,
    reservMode: nr,
    reservTarget: nt,
    dispatched: dispatchedCount > 0,
  };
};


// ── Helpers ──────────────────────────────────────────────────────────────────

export const fmtTime = (s: number): string => {
  if (!isFinite(s)) return '∞';
  s = Math.max(0, Math.floor(s));
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

let _jobId = 1;
export const newJobId = (): string => {
  return `job-${String(_jobId++).padStart(3, '0')}`;
};

export const resetJobIdCounter = (): void => {
  _jobId = 1;
};

export const shallowCloneOrgUsage = (ou: OrgUsageMap): OrgUsageMap => {
  const result: OrgUsageMap = {};
  for (const orgKey of Object.keys(ou)) {
    const pools = ou[orgKey];
    const clonedPools: Record<string, Resources> = {};
    for (const poolKey of Object.keys(pools)) {
      clonedPools[poolKey] = { ...pools[poolKey] };
    }
    result[orgKey] = clonedPools;
  }
  return result;
};
