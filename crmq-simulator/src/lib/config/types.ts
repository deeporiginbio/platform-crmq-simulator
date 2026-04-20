/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Configuration Architecture — Types
 * ====================================
 * Discriminated unions for polymorphic formula and limit configurations.
 * Uses the registry pattern: each formula/limit type is self-contained
 * with its own component, schema, defaults, and resolution logic.
 */

import type { z } from 'zod';
import type { Resources, CRMQConfig, Org, QuotaType } from '../types';
import { cpuMillisFromVcpu, memoryMiBFromGb, vcpuFromCpuMillis } from '../units';

// ── Resource Derivation Ratios ──────────────────────────────────────────────
// Users configure ONE dimension per pool (vCPU or GPU). The rest is derived.
//   1 vCPU = 4 GB memory
//   1 GPU  = 4 vCPU  (i.e. vCPU = GPU × 4)
//
// Note: these ratios describe the *UI-facing* dimensions (vCPU, GB, GPU).
// Internally the model stores cpuMillis and memoryMiB; see src/lib/units.ts.

export const MEMORY_GB_PER_VCPU = 4;    // 1 vCPU → 4 GB
export const VCPU_PER_GPU = 4;          // 1 GPU  → 4 vCPU

/**
 * Derive full Resources from the user-configured dimension.
 *   quotaType 'cpu' → user sets vCPU; memory = vCPU × 4 GB; gpu = 0
 *   quotaType 'gpu' → user sets GPU; vCPU = GPU × 4; memory = vCPU × 4 GB
 *
 * Takes UI-facing values (vCPU or GPU count) and returns canonical model
 * Resources (cpuMillis, memoryMiB, gpu). All model values are stored as
 * integers via the units.ts helpers.
 */
export const deriveResources = (quotaType: QuotaType, value: number): Resources => {
  if (quotaType === 'gpu') {
    const vcpu = value * VCPU_PER_GPU;
    return {
      cpuMillis: cpuMillisFromVcpu(vcpu),
      memoryMiB: memoryMiBFromGb(vcpu * MEMORY_GB_PER_VCPU),
      gpu: value,
    };
  }
  // cpu pool — no GPU at all. `value` here is UI vCPU.
  return {
    cpuMillis: cpuMillisFromVcpu(value),
    memoryMiB: memoryMiBFromGb(value * MEMORY_GB_PER_VCPU),
    gpu: 0,
  };
};

/**
 * Extract the user-configurable value from a Resources object given the pool
 * quotaType. Returns UI-facing units: vCPU (decimal) for 'cpu', GPU count for
 * 'gpu'.
 */
export const getUserValue = (quotaType: QuotaType, resources: Resources): number =>
  quotaType === 'gpu' ? resources.gpu : vcpuFromCpuMillis(resources.cpuMillis);

/**
 * Label for the user-configurable dimension.
 */
export const getQuotaLabel = (quotaType: QuotaType): string =>
  quotaType === 'gpu' ? 'GPU' : 'CPU';

// ── Formula System ──────────────────────────────────────────────────────────

/**
 * Current Weighted Score (baseline production formula).
 * Score = (OrgP × orgWeight) + (UserP × userWeight) + (ToolP × toolWeight) + (Wait × agingFactor)
 */
export interface CurrentWeightedParams {
  orgWeight: number;
  userWeight: number;
  toolWeight: number;
  agingFactor: number;
}

/**
 * Normalized Weighted Sum + Log Aging (§4.2 recommendation).
 * All weights sum to 1.0 with logarithmic aging for bounded starvation prevention.
 */
export interface NormalizedWeightedSumParams {
  wTier: number;
  wAge: number;
  wUser: number;
  wTool: number;
  C: number;
  tau: number;
}

/**
 * DRF Fair Share + Log Aging (§3.1, §6.1).
 * Dominant Resource Fairness for inter-org scheduling.
 */
export interface DrfFairShareParams {
  C: number;
  tau: number;
}

/**
 * Balanced Composite (Deep Origin) — multi-factor normalized formula.
 *
 * t     = wait / agingHorizon
 * aging  = agingFloor × t + (1 − agingFloor) × t ^ agingExponent
 * score  = wPriority × (org_priority / 10)
 *        + wAging   × min(1, aging)
 *        + wLoad    × (1 − org_cpus_in_pool / pool_total_cpu)
 *        + wCpuHrs  × (1 − min(1, log(1+cpu_hours) / log(1+maxCpuHours)))
 *
 * where cpu_hours = cpu_requested × estimatedDuration (in hours).
 * Aging uses a blended curve: a linear floor (10%) ensures aging
 * is never truly zero, while the quadratic body (90%) keeps the
 * "slow start, aggressive end" shape. Full boost at agingHorizon
 * (6 h), matching the longest real job durations.
 * Org load is CPU-only (AWS EKS bills by vCPU).
 */
export interface BalancedCompositeParams {
  wPriority: number;
  wAging: number;
  wLoad: number;
  wCpuHrs: number;
  agingHorizon: number;   // wait time for full boost in seconds (default 21600 = 6h)
  agingExponent: number;  // curve shape: >1 = slow start (default 2 = quadratic)
  agingFloor: number;     // linear floor fraction (default 0.10 = 10%)
  maxCpuHours: number;    // normalization ceiling for cpu_hours (default 1000)
}

/**
 * Strict FIFO baseline — no configurable params.
 */
export type StrictFifoParams = Record<string, never>;

/**
 * Discriminated union of all formula configurations.
 * The `type` field determines which params are present.
 * Adding a new formula = adding a new branch here + a registry entry.
 */
export type FormulaConfig =
  | { type: 'current_weighted'; params: CurrentWeightedParams }
  | { type: 'normalized_weighted_sum'; params: NormalizedWeightedSumParams }
  | { type: 'drf_fair_share'; params: DrfFairShareParams }
  | { type: 'balanced_composite'; params: BalancedCompositeParams }
  | { type: 'strict_fifo'; params: StrictFifoParams };

export type FormulaType = FormulaConfig['type'];


// ── Limit System ────────────────────────────────────────────────────────────

export type LimitMode = 'absolute' | 'percentage' | 'uncapped';

/**
 * Discriminated union of limit values.
 * The `mode` field determines the shape.
 */
export type LimitValue =
  | { mode: 'absolute'; resources: Resources }
  | { mode: 'percentage'; pct: Resources }  // each dim is 0–100
  | { mode: 'uncapped' };

/** Per-org, per-pool limit configuration */
export interface OrgQuotaConfig {
  orgId: string;
  limits: Record<string, LimitValue>;  // keyed by pool type
}


// ── Full Scheduling Policy ──────────────────────────────────────────────────

export interface SchedulingPolicyConfig {
  formula: FormulaConfig;
  scheduler: {
    topN: number;
    skipThreshold: number;
    backfillMaxRatio: number;
  };
  cluster: {
    pools: CRMQConfig['cluster']['pools'];
  };
  orgQuotas: OrgQuotaConfig[];
  ttlDefault: number;
}


// ── Registry Interfaces ─────────────────────────────────────────────────────

/**
 * A formula definition registers:
 * - metadata (label, description, icon)
 * - Zod schema for validation
 * - default parameter values
 * - which limit types are compatible
 *
 * The React component is registered separately in the component layer
 * to keep this file framework-agnostic.
 */
export interface FormulaDefinition<P = unknown> {
  id: FormulaType;
  label: string;
  description: string;
  icon: string;
  schema: z.ZodType<P>;
  defaultParams: P;
  compatibleLimitTypes: LimitMode[];
}

/**
 * A limit definition registers:
 * - metadata
 * - Zod schema
 * - default value
 * - resolve function: converts to absolute Resources given pool totals
 */
export interface LimitDefinition<V = unknown> {
  mode: LimitMode;
  label: string;
  description: string;
  icon: string;
  schema: z.ZodType<V>;
  defaultValue: V;
  /** Resolve this limit to absolute Resources, given the pool's total capacity */
  resolve: (value: V, poolTotal: Resources) => Resources;
}


// ── Validation ──────────────────────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationMessage {
  severity: ValidationSeverity;
  field?: string;      // e.g. "orgQuotas.deeporigin.mason-gpu.cpu"
  pool?: string;       // pool type if pool-scoped
  orgId?: string;      // org ID if org-scoped
  message: string;
}


// ── Benchmark Types ─────────────────────────────────────────────────────────

export type BenchmarkStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BenchmarkScenario {
  id: string;
  name: string;
  config: CRMQConfig;
  orgs: Org[];
}

export interface BenchmarkMetrics {
  avgWaitTime: number;
  maxWaitTime: number;
  p95WaitTime: number;
  throughput: number;          // jobs completed per minute
  utilization: Record<string, number>;  // per-pool CPU utilization %
  evictionRate: number;        // % of jobs evicted by TTL
  fairnessIndex: number;       // Jain's fairness index (0–1)
  orgMetrics: Record<string, {
    avgWaitTime: number;
    jobsCompleted: number;
    jobsEvicted: number;
  }>;
}

export interface BenchmarkRun {
  id: string;
  name: string;
  createdAt: number;
  status: BenchmarkStatus;
  scenarios: BenchmarkScenario[];
  workload: {
    jobs: Array<{ name: string; orgId: string; userPriority: number; toolPriority: number; resources: Resources; estimatedDuration: number; ttl: number }>;
    arrivalPattern: 'burst' | 'uniform' | 'poisson';
  };
  results?: Record<string, BenchmarkMetrics>;  // keyed by scenario ID
  duration?: number;  // sim-time duration of the benchmark run
}

export interface BenchmarkReport {
  id: string;
  name: string;
  createdAt: number;
  benchmarkRunId: string;
  summary: string;
  formulaNames: string[];
  scenarioNames: string[];
}
