/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Pluggable Scoring Formula Registry
 * ======================================================
 * Decouples the scoring function from the scheduler so that:
 *
 *   1. The DES engine can swap formulas without touching scheduler.ts
 *   2. New formulas (DRF, CFS-vruntime, normalized weighted-sum) can be
 *      added by implementing ScoringFormula and registering them
 *   3. Benchmark runs can compare formulas side-by-side
 *
 * The existing calcScore() in scheduler.ts remains the "production" scorer.
 * This registry provides benchmark-only alternatives that don't change
 * the live visual simulator until explicitly promoted.
 *
 * § 4.2 of the research report recommends:
 *   - Normalized weighted-sum with logarithmic aging
 *   - DRF for org-level fairness
 *   - Jain's Fairness Index > 0.85
 */

import type { Job, CRMQConfig, Org, OrgUsageMap, Resources } from '../types';
import { jobPools, jobResInPool, jobTotalResources } from '../types';
import { vcpuFromCpuMillis } from '../units';

// ── Scoring Function Interface ────────────────────────────────────────────

/**
 * A scoring function takes a job and context, returns a numeric score.
 * Higher score = higher priority (dispatched sooner).
 */
export type ScoreFn = (
  job: Job,
  now: number,
  config: CRMQConfig,
  orgs: Org[],
  /** Optional: current org resource usage (needed for DRF) */
  orgUsage?: OrgUsageMap,
) => number;

/**
 * A registered scoring formula with metadata for the benchmark UI.
 */
export interface ScoringFormula {
  id: string;
  name: string;
  description: string;
  /** Which research report section recommends this */
  reference: string;
  /** The actual scoring function */
  score: ScoreFn;
  /** Default parameters (for display / config UI) */
  defaultParams: Record<string, number>;
}

// ── Built-in Formulas ─────────────────────────────────────────────────────

/**
 * Current production formula (for baseline comparison).
 * score = org.priority × orgWeight + userP × userWeight + toolP × toolWeight + wait × agingFactor
 */
const currentWeightedScore: ScoringFormula = {
  id: 'current_weighted',
  name: 'Weighted Score (CRMQ Design)',
  description: 'Linear additive formula with fixed weights. Uses linear aging. The current production formula.',
  reference: '§1 (current implementation)',
  score: (job, now, config, orgs) => {
    const org = orgs.find(o => o.id === job.orgId) ?? { priority: 3 };
    const wait = Math.max(0, now - job.enqueuedAt);
    const s = config.scoring;
    return (
      org.priority * s.orgWeight +
      job.userPriority * s.userWeight +
      job.toolPriority * s.toolWeight +
      wait * s.agingFactor
    );
  },
  defaultParams: { orgWeight: 10000, userWeight: 1000, toolWeight: 100, agingFactor: 5 },
};

/**
 * Normalized weighted-sum with logarithmic aging (§4.2 recommendation).
 *
 * score = w_tier × tier_factor(org) + w_age × log_age(wait) +
 *         w_user × norm(userP) + w_tool × norm(toolP)
 *
 * All weights sum to 1.0.
 * tier_factor: maps org.priority [1–5] to [0, 1]
 * log_age: min(max_boost, C × log₂(1 + wait/tau))
 * norm: maps [1–5] to [0, 1]
 */
const normalizedWeightedSum: ScoringFormula = {
  id: 'normalized_weighted_sum',
  name: 'Normalized Weighted Sum + Log Aging',
  description: 'Research-recommended formula: normalized inputs summing to 1.0 with logarithmic aging for bounded starvation prevention.',
  reference: '§4.2, §6.1',
  score: (job, now, _config, orgs) => {
    const org = orgs.find(o => o.id === job.orgId) ?? { priority: 3 };
    const wait = Math.max(0, now - job.enqueuedAt);

    // Parameters (configurable via defaultParams)
    const wTier = 0.30;
    const wAge = 0.30;
    const wUser = 0.25;
    const wTool = 0.15;
    const C = 10;          // aging coefficient
    const tau = 60;        // aging time constant (seconds)
    const maxBoost = 1.0;  // cap on aging contribution (normalized)
    const maxPriority = 5;

    // Normalize inputs to [0, 1]
    const tierFactor = org.priority / maxPriority;
    const userFactor = (job.userPriority - 1) / 4;  // [1,5] → [0,1]
    const toolFactor = (job.toolPriority - 1) / 4;

    // Logarithmic aging: min(max_boost, C × log₂(1 + wait/tau)) / C
    // Normalized so max value ≈ 1.0 after sufficient wait
    const rawAge = C * Math.log2(1 + wait / tau);
    const ageFactor = Math.min(maxBoost, rawAge / (C * Math.log2(1 + 3600 / tau)));

    return wTier * tierFactor + wAge * ageFactor + wUser * userFactor + wTool * toolFactor;
  },
  defaultParams: { wTier: 0.30, wAge: 0.30, wUser: 0.25, wTool: 0.15, C: 10, tau: 60 },
};

/**
 * DRF-Aware Fair Share (§3.1, §6.1).
 *
 * Instead of a simple composite score, this uses Dominant Resource Fairness:
 * 1. Compute each org's "dominant share" (max of cpu_share, gpu_share, mem_share)
 * 2. The org with the lowest dominant share gets priority
 * 3. Within same org, use normalized composite score with log aging
 *
 * Score structure: (1 - dominantShare) × 10000 + withinOrgScore
 * This ensures the least-served org always wins over a more-served org.
 */
const drfFairShare: ScoringFormula = {
  id: 'drf_fair_share',
  name: 'DRF Fair Share + Log Aging',
  description: 'Dominant Resource Fairness for inter-org scheduling, with normalized composite score and logarithmic aging within each org.',
  reference: '§3.1, §4.2, §6.1',
  score: (job, now, config, orgs, orgUsage) => {
    const org = orgs.find(o => o.id === job.orgId) ?? { priority: 3 };
    const wait = Math.max(0, now - job.enqueuedAt);

    // Compute dominant share for this org, averaged across the pools the job
    // touches, cpuMillis-weighted (§1.4 platform parity). Single-pool jobs
    // reduce to the original behaviour; multi-pool jobs get a combined share
    // that reflects their per-pool CPU footprint.
    let dominantShare = 0;
    if (orgUsage) {
      const pools = jobPools(job);
      let weightedDominant = 0;
      let totalCpu = 0;
      for (const poolType of pools) {
        const pool = config.cluster.pools.find(p => p.type === poolType);
        if (!pool) continue;
        const used =
          orgUsage[job.orgId]?.[poolType]
          ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
        const ext = pool.externalUsage ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
        const total: Resources = {
          cpuMillis: Math.max(0, pool.total.cpuMillis - ext.cpuMillis - pool.reserved.cpuMillis),
          memoryMiB: Math.max(0, pool.total.memoryMiB - ext.memoryMiB - pool.reserved.memoryMiB),
          gpu:       Math.max(0, pool.total.gpu       - ext.gpu       - pool.reserved.gpu),
        };
        const cpuShare =
          total.cpuMillis > 0 ? used.cpuMillis / total.cpuMillis : 0;
        const memShare =
          total.memoryMiB > 0 ? used.memoryMiB / total.memoryMiB : 0;
        const gpuShare = total.gpu > 0 ? used.gpu / total.gpu : 0;
        const poolDominant = Math.max(cpuShare, memShare, gpuShare);

        const reqCpu = jobResInPool(job, poolType).cpuMillis;
        weightedDominant += reqCpu * poolDominant;
        totalCpu += reqCpu;
      }
      dominantShare = totalCpu > 0
        ? Math.min(1, Math.max(0, weightedDominant / totalCpu))
        // Job requests no cpuMillis anywhere — fall back to the max dominant
        // across touched pools so we still distinguish heavy orgs.
        : pools.reduce<number>((acc, pt) => {
            const pool = config.cluster.pools.find(p => p.type === pt);
            if (!pool) return acc;
            const used = orgUsage[job.orgId]?.[pt] ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
            const ext = pool.externalUsage ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
            const total = {
              cpuMillis: Math.max(0, pool.total.cpuMillis - ext.cpuMillis - pool.reserved.cpuMillis),
              memoryMiB: Math.max(0, pool.total.memoryMiB - ext.memoryMiB - pool.reserved.memoryMiB),
              gpu:       Math.max(0, pool.total.gpu       - ext.gpu       - pool.reserved.gpu),
            };
            const cs = total.cpuMillis > 0 ? used.cpuMillis / total.cpuMillis : 0;
            const ms = total.memoryMiB > 0 ? used.memoryMiB / total.memoryMiB : 0;
            const gs = total.gpu > 0 ? used.gpu / total.gpu : 0;
            return Math.max(acc, cs, ms, gs);
          }, 0);
    }

    // Weight by org priority: higher-priority orgs get a natural bonus
    // But DRF ensures even low-priority orgs get proportional resources
    const priorityWeight = org.priority / 5;

    // Logarithmic aging
    const C = 10;
    const tau = 60;
    const rawAge = Math.min(1, (C * Math.log2(1 + wait / tau)) / (C * Math.log2(1 + 3600 / tau)));

    // Within-org score
    const userFactor = (job.userPriority - 1) / 4;
    const toolFactor = (job.toolPriority - 1) / 4;
    const withinOrg = 0.3 * userFactor + 0.2 * toolFactor + 0.5 * rawAge;

    // DRF: favor orgs with lower dominant share
    // Scale: (1 - dominantShare) in [0, 1], multiplied by priority weight
    // Then add within-org score as tiebreaker
    return (1 - dominantShare) * priorityWeight * 10000 + withinOrg * 100;
  },
  defaultParams: { C: 10, tau: 60 },
};

/**
 * Balanced Composite (Deep Origin) — production formula.
 *
 * pool = gpu_requested > 0 ? "mason-gpu" : "mason"
 *
 * org_priority_norm = org_priority / 5
 * t                 = wait / AGING_HORIZON
 * aging             = min(1, AGING_FLOOR × t + (1 − AGING_FLOOR) × t²)
 * org_load          = org_cpus_in_pool / pool_total_cpu
 * cpu_hours         = cpu_requested × est_duration_hrs
 * cpu_hrs_norm      = min(1, log(1 + cpu_hours) / log(1 + MAX_CPU_HOURS))
 *
 * score = 0.35 × org_priority_norm
 *       + 0.25 × aging
 *       + 0.20 × (1 − org_load)
 *       + 0.20 × (1 − cpu_hrs_norm)
 *
 * Aging uses a blended curve: a small linear floor (10%) ensures
 * aging is never truly zero, while the quadratic component (90%)
 * keeps the "slow start, aggressive end" shape. Full boost at
 * AGING_HORIZON (6 h), matching the longest real job durations.
 *
 * Org load is CPU-only by design: AWS EKS billing and quota
 * enforcement are measured in vCPU, so CPU is the authoritative
 * resource dimension for load scoring.
 */
const balancedComposite: ScoringFormula = {
  id: 'balanced_composite',
  name: 'Balanced Composite (Deep Origin)',
  description:
    'Production formula: org priority, blended aging'
    + ' (10% linear floor + 90% quadratic, full at 6 h),'
    + ' inverse org CPU load, and inverse log-normalized'
    + ' CPU-hours. All normalized to [0,1].',
  reference: 'Custom (Deep Origin team-designed)',
  score: (job, now, config, orgs, orgUsage) => {
    const org =
      orgs.find(o => o.id === job.orgId) ?? { priority: 3 };
    const wait = Math.max(0, now - job.enqueuedAt);

    // Configurable weights
    const wPriority = 0.35;
    const wAging = 0.25;
    const wLoad = 0.20;
    const wCpuHrs = 0.20;

    // Configurable constants
    const AGING_HORIZON = 21600;   // 6 h — full boost at this wait
    const AGING_EXPONENT = 2;      // quadratic: slow start, steep end
    const AGING_FLOOR = 0.10;      // 10% linear floor — never fully zero
    const MAX_CPU_HOURS = 1000;    // vCPU·hours — matches platform default
    const maxPriority = 5;

    // 1. Normalized org priority [0, 1]
    const orgPriorityNorm = org.priority / maxPriority;

    // 2. Blended aging curve [0, 1]
    //    floor × t + (1 − floor) × t^exp
    //    Linear floor ensures aging is nonzero from the start;
    //    quadratic body keeps the accelerating ramp toward 6 h.
    const t = Math.min(1, wait / AGING_HORIZON);
    const aging =
      AGING_FLOOR * t
      + (1 - AGING_FLOOR)
        * Math.pow(t, AGING_EXPONENT);

    // 3. Org load — cpuMillis-weighted across the pools the job touches
    //    (§1.4 platform parity). For each requested pool, compute
    //    load_t = org_cpuMillis_in_pool_t / effective_cpu_pool_t. Weight
    //    each load by cpuMillis_t (the job's CPU slice in that pool) and
    //    divide by the job's total cpuMillis. For single-pool jobs this
    //    collapses to the original behaviour.
    //
    //    CPU-only on purpose — AWS EKS measures and bills by vCPU, so CPU
    //    is the authoritative dimension for load.
    let orgLoad = 0;
    if (orgUsage) {
      const pools = jobPools(job);
      let weightedLoad = 0;
      let totalCpu = 0;
      let fallbackMax = 0; // used when the job's cpuMillis is 0 across all pools
      for (const poolType of pools) {
        const pool = config.cluster.pools.find(p => p.type === poolType);
        if (!pool) continue;
        const used = orgUsage[job.orgId]?.[poolType]
          ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
        const ext = pool.externalUsage ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 };
        const effectiveCpu = Math.max(
          0,
          pool.total.cpuMillis - ext.cpuMillis - pool.reserved.cpuMillis,
        );
        const loadT = effectiveCpu > 0
          ? Math.min(1, used.cpuMillis / effectiveCpu)
          // Numerator > 0 with denominator = 0 means the pool is fully
          // reserved/external — treat as saturated.
          : used.cpuMillis > 0 ? 1 : 0;

        const reqCpu = jobResInPool(job, poolType).cpuMillis;
        weightedLoad += reqCpu * loadT;
        totalCpu += reqCpu;
        if (loadT > fallbackMax) fallbackMax = loadT;
      }
      orgLoad = totalCpu > 0
        ? Math.min(1, Math.max(0, weightedLoad / totalCpu))
        : fallbackMax;
    }

    // 4. CPU-hours: vcpu_requested (summed across all pools) × duration (hrs).
    //    Multi-pool jobs contribute every pool's CPU slice — mirrors the
    //    platform aggregation where total CPU footprint drives the "big job"
    //    penalty (balanced-composite-scoring.strategy.ts:337). Single-pool
    //    jobs reduce to the original behaviour.
    const totalsForCpuHrs = jobTotalResources(job);
    const vcpu = vcpuFromCpuMillis(totalsForCpuHrs.cpuMillis);
    const cpuHours = vcpu * (job.estimatedDuration / 3600);
    const cpuHrsNorm = Math.min(
      1,
      Math.log(1 + cpuHours) / Math.log(1 + MAX_CPU_HOURS),
    );

    return wPriority * orgPriorityNorm
         + wAging   * aging
         + wLoad    * (1 - orgLoad)
         + wCpuHrs  * (1 - cpuHrsNorm);
  },
  defaultParams: {
    wPriority: 0.35,
    wAging: 0.25,
    wLoad: 0.20,
    wCpuHrs: 0.20,
    agingHorizon: 21600,
    agingExponent: 2,
    agingFloor: 0.10,
    maxCpuHours: 1000,
  },
};

/**
 * Strict FIFO (for baseline comparison).
 * Score = enqueuedAt (earlier enqueue = higher score, inverted).
 */
const strictFIFO: ScoringFormula = {
  id: 'strict_fifo',
  name: 'Strict FIFO (Baseline)',
  description: 'Pure first-in-first-out ordering. No priority, no aging. Useful as a baseline for comparison.',
  reference: 'N/A (baseline)',
  score: (job) => {
    // Earlier enqueue → higher score
    return 1_000_000 - job.enqueuedAt;
  },
  defaultParams: {},
};

// ── Formula Registry ──────────────────────────────────────────────────────

const _registry = new Map<string, ScoringFormula>();

// Register built-in formulas
[currentWeightedScore, normalizedWeightedSum, drfFairShare, balancedComposite, strictFIFO]
  .forEach(f => _registry.set(f.id, f));

/**
 * Get all registered formulas.
 */
export const getFormulas = (): ScoringFormula[] => Array.from(_registry.values());

/**
 * Get a formula by ID.
 */
export const getFormula = (id: string): ScoringFormula | undefined => _registry.get(id);

/**
 * Register a custom formula (for extensibility).
 */
export const registerFormula = (formula: ScoringFormula): void => {
  _registry.set(formula.id, formula);
};

/**
 * Create a ScoreFn from a formula ID that can be passed to the DES engine.
 * Falls back to the current production formula if ID not found.
 */
export const createScoreFn = (formulaId: string): ScoreFn => {
  const formula = _registry.get(formulaId);
  if (!formula) return currentWeightedScore.score;
  return formula.score;
};
