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
  getJobPoolType,
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
    topN:               10,
    skipThreshold:       3,
    backfillMaxRatio:  0.5,
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
        routeWhen: (job) => job.resources.gpu === 0,
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
        routeWhen: (job) => job.resources.gpu > 0,
      },
    ],
  },
  ttlDefault: Infinity,
  formulaType: 'balanced_composite',
};

export const DEFAULT_ORGS: Org[] = [
  {
    id: 'deeporigin', name: 'Deeporigin', priority: 3,
    limits: {
      mason: {
        cpuMillis: cpuMillisFromVcpu(1364),
        memoryMiB: memoryMiBFromGb(5456),
        gpu: 0,
      },
      'mason-gpu': {
        cpuMillis: cpuMillisFromVcpu(768),
        memoryMiB: memoryMiBFromGb(3072),
        gpu: 192,
      },
    },
  },
  {
    id: 'org-beta', name: 'Partner Org', priority: 2,
    limits: {
      mason: {
        cpuMillis: cpuMillisFromVcpu(384),
        memoryMiB: memoryMiBFromGb(1536),
        gpu: 0,
      },
      'mason-gpu': {
        cpuMillis: cpuMillisFromVcpu(192),
        memoryMiB: memoryMiBFromGb(768),
        gpu: 48,
      },
    },
  },
  {
    id: 'org-gamma', name: 'Research Lab', priority: 1,
    limits: {
      mason: {
        cpuMillis: cpuMillisFromVcpu(384),
        memoryMiB: memoryMiBFromGb(1536),
        gpu: 0,
      },
      'mason-gpu': {
        cpuMillis: cpuMillisFromVcpu(192),
        memoryMiB: memoryMiBFromGb(768),
        gpu: 48,
      },
    },
  },
];

/**
 * Shorthand for PRESET_JOBS: vCPU + GB → canonical Resources (cpuMillis/memoryMiB).
 * Keeps the fixture table readable in UI units.
 */
const res = (vcpu: number, gb: number, gpu: number): Resources => ({
  cpuMillis: cpuMillisFromVcpu(vcpu),
  memoryMiB: memoryMiBFromGb(gb),
  gpu,
});

export const PRESET_JOBS: Omit<Job, 'id' | 'enqueuedAt' | 'skipCount'>[] = [
  { name: 'Ligand Prep',         orgId: 'deeporigin', userPriority: 3, toolPriority: 2, resources: res(  4,  16, 0), estimatedDuration:  45, ttl: Infinity },
  { name: 'GPU Docking (large)', orgId: 'deeporigin', userPriority: 5, toolPriority: 4, resources: res(  8,  32, 4), estimatedDuration: 120, ttl: Infinity },
  { name: 'Data Ingestion',      orgId: 'org-beta',   userPriority: 2, toolPriority: 1, resources: res(  2,   8, 0), estimatedDuration:  30, ttl: Infinity },
  { name: 'ML Training',         orgId: 'org-beta',   userPriority: 4, toolPriority: 3, resources: res( 16,  64, 2), estimatedDuration: 180, ttl: Infinity },
  { name: 'API Serving',         orgId: 'org-gamma',  userPriority: 5, toolPriority: 5, resources: res(  4,  16, 0), estimatedDuration:  60, ttl: Infinity },
  { name: 'Pocket Finding',      orgId: 'org-gamma',  userPriority: 3, toolPriority: 2, resources: res(  8,  32, 2), estimatedDuration:  90, ttl: Infinity },
  { name: 'Parallel Docking ×4', orgId: 'deeporigin', userPriority: 4, toolPriority: 3, resources: res( 32, 128, 8), estimatedDuration: 200, ttl: Infinity },
  { name: 'Quick Analysis',      orgId: 'org-beta',   userPriority: 2, toolPriority: 1, resources: res(  2,   4, 0), estimatedDuration:  15, ttl: Infinity },
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

export const sumResources = (
  jobs: Array<{ resources: Resources }>,
): Resources => {
  return jobs.reduce<Resources>((acc, j) => add3(acc, j.resources), { ...ZERO });
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
    const org = orgs.find(o => o.id === job.orgId) ?? { priority: 1 };
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

export const getPoolAvailability = (
  config: CRMQConfig,
  activeJobs: RunningJob[],
  poolType: string,
): Resources => {
  const pool = getPool(config, poolType);
  const poolJobs = activeJobs.filter(j => getJobPoolType(j, config) === poolType);
  const inUse = sumResources(poolJobs);
  return sub3(sub3(pool.total, pool.reserved), inUse);
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
      const poolType = getJobPoolType(j, config);
      const orgPools = updOrgUsage[j.orgId] ?? zeroPoolUsage(config);
      orgPools[poolType] = sub3(orgPools[poolType], j.resources);
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

  let dispatched = false;

  for (const job of topN) {
    if (dispatched) break;

    const org = orgs.find(o => o.id === job.orgId);
    const poolType = getJobPoolType(job, config);
    const orgPoolLimits = org?.limits[poolType] ?? UNLIMITED_RES;
    const orgPools = no[job.orgId] ?? zeroPoolUsage(config);
    const orgUsedInPool = orgPools[poolType] ?? cloneZero();

    // Gate 1: Org Quota (per-pool)
    const orgOk = (
      orgUsedInPool.cpuMillis + job.resources.cpuMillis <= orgPoolLimits.cpuMillis &&
      orgUsedInPool.memoryMiB + job.resources.memoryMiB <= orgPoolLimits.memoryMiB &&
      orgUsedInPool.gpu       + job.resources.gpu       <= orgPoolLimits.gpu
    );
    if (!orgOk) {
      logFn?.(now, `⛔ Gate 1 FAIL | ${job.name} [${job.id}] — ${org?.name ?? job.orgId} ${poolType} quota exceeded (SKIP)`, 'warn');
      nq = nq.map(j => j.id === job.id ? { ...j, skipCount: (j.skipCount || 0) + 1 } : j);
      continue;
    }

    // Reservation mode gate
    if (nr && nt && job.id !== nt) {
      logFn?.(now, `🔒 Reservation mode | blocking ${job.name} [${job.id}] — reserving for ${nt}`, 'warn');
      continue;
    }

    // Gate 2: Pool Capacity (poolType already computed above)
    const avail = availByPool[poolType];

    // Gate 2: Pool Capacity
    const capOk = fits(job.resources, avail);
    if (!capOk) {
      const newSkip = (job.skipCount || 0) + 1;
      nq = nq.map(j => j.id === job.id ? { ...j, skipCount: newSkip } : j);
      logFn?.(now, `⛔ Gate 2 FAIL | ${job.name} [${job.id}] — ${poolType} pool capacity insufficient. skip_count=${newSkip}/${sch.skipThreshold}`, 'warn');

      // §3.4 Large Task Guarantees
      if (newSkip > sch.skipThreshold && !nr) {
        nr = true; nt = job.id;
        logFn?.(now, `🔒 RESERVATION MODE ON | ${job.name} [${job.id}] skipped ${newSkip}× — blocking new dispatches`, 'error');
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
          .filter(j => {
            const bf_poolType = getJobPoolType(j, config);
            return fits(j.resources, availByPool[bf_poolType]);
          })
          .filter(j => j.estimatedDuration <= job.estimatedDuration * sch.backfillMaxRatio);

        for (const bf of candidates) {
          const bf_poolType = getJobPoolType(bf, config);
          const bfOrgPools = no[bf.orgId] ?? zeroPoolUsage(config);
          const bfOrgUsedInPool = bfOrgPools[bf_poolType] ?? cloneZero();
          const bfOrg = orgs.find(o => o.id === bf.orgId);
          const bfLimits = bfOrg?.limits[bf_poolType] ?? UNLIMITED_RES;
          const bfOrgOk = (
            bfOrgUsedInPool.cpuMillis + bf.resources.cpuMillis <= bfLimits.cpuMillis &&
            bfOrgUsedInPool.memoryMiB + bf.resources.memoryMiB <= bfLimits.memoryMiB &&
            bfOrgUsedInPool.gpu       + bf.resources.gpu       <= bfLimits.gpu
          );
          if (bfOrgOk) {
            na = [...na, { ...bf, startedAt: now, remainingDuration: bf.estimatedDuration }];
            nq = nq.filter(j => j.id !== bf.id);
            const bfDispPools = { ...bfOrgPools };
            bfDispPools[bf_poolType] = add3(bfDispPools[bf_poolType], bf.resources);
            no = { ...no, [bf.orgId]: bfDispPools };
            availByPool[bf_poolType] = sub3(availByPool[bf_poolType], bf.resources);
            logFn?.(now, `🔀 BACKFILL | ${bf.name} [${bf.id}] — fits gap, dur ${fmtTime(bf.estimatedDuration)} ≤ ${sch.backfillMaxRatio * 100}% of blocked`, 'success');
            dispatched = true;
            break;
          }
        }
      }
      continue;
    }

    // ✅ DISPATCH
    const wait = now - job.enqueuedAt;
    // Log in UI units (vCPU + GB) — model uses cpuMillis + memoryMiB internally.
    const vcpu = vcpuFromCpuMillis(job.resources.cpuMillis);
    const gb = gbFromMemoryMiB(job.resources.memoryMiB);
    logFn?.(now, `✅ DISPATCH | ${job.name} [${job.id}] → ${poolType} — score=${Math.round(job._score).toLocaleString()}, wait=${fmtTime(wait)}, CPU:${vcpu} MEM:${gb}GB GPU:${job.resources.gpu}`, 'success');

    na = [...na, { ...job, startedAt: now, remainingDuration: job.estimatedDuration }];
    nq = nq.filter(j => j.id !== job.id);
    const dispOrgPools = { ...(no[job.orgId] ?? zeroPoolUsage(config)) };
    dispOrgPools[poolType] = add3(dispOrgPools[poolType], job.resources);
    no = { ...no, [job.orgId]: dispOrgPools };
    availByPool[poolType] = sub3(availByPool[poolType], job.resources);

    if (nr && nt === job.id) {
      nr = false; nt = null;
      logFn?.(now, '🔓 Reservation mode cleared — target dispatched', 'info');
    }
    dispatched = true;
  }

  return { queue: nq, active: na, orgUsage: no, reservMode: nr, reservTarget: nt, dispatched };
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
