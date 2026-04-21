/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Domain Types
 * =================
 * Type definitions for the Cost & Resource Management Queue system.
 *
 * Pool types are NOT hardcoded — the system derives them from config.
 * Known pool types today: "mason" (CPU-only) and "mason-gpu" (GPU workloads).
 */

import { z } from 'zod';

// ── Resource Dimensions ──────────────────────────────────────────────────────

/**
 * Resources — canonical model shape matching platform `ComputeResources`.
 *
 *   cpuMillis: 1000 = 1 vCPU  (matches platform cpuMillis)
 *   memoryMiB: 1024 = 1 GiB   (matches platform memoryMiB)
 *   gpu:       whole GPU count
 *
 * UI layers display vCPU / GB and convert at the boundary via
 * helpers in `src/lib/units.ts`. Do not use raw `cpuMillis` or
 * `memoryMiB` in user-facing labels.
 */
export interface Resources {
  cpuMillis: number;
  memoryMiB: number;
  gpu: number;
}

export const resourcesSchema = z.object({
  cpuMillis: z.number(),
  memoryMiB: z.number(),
  gpu: z.number(),
});

// ── Organization ─────────────────────────────────────────────────────────────

/**
 * Org quotas are keyed by pool type string (derived from config).
 * Each value is a raw **percentage** of the pool's available capacity
 * (pool.total − pool.reserved), in the range [0, 100]. This mirrors the
 * platform's `resourceQuota` column in `organizations` (default 100%).
 * A single percent applies uniformly to all resource dimensions in that
 * pool — we do not tune per-dimension.
 */
export interface Org {
  id: string;
  name: string;
  priority: number; // 1–5, higher = more important (platform parity)
  /** per-pool percentage quota in [0, 100]. Missing key ⇒ unlimited within pool. */
  limits: Record<string, number>;
}

export const orgSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Platform parity: ORGANIZATION_PRIORITY CHECK (value BETWEEN 1 AND 5)
  priority: z.number().int().min(1).max(5),
  limits: z.record(z.string(), z.number().min(0).max(100)),
});

// ── Job Lifecycle ────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  name: string;
  orgId: string;
  userPriority: number;  // 1–5
  toolPriority: number;  // 1–5
  resources: Resources;
  estimatedDuration: number; // seconds
  ttl: number;               // seconds — time-to-live in queue (§1.2)
  enqueuedAt: number;        // sim-time when enqueued
  skipCount: number;         // times skipped by scheduler (§3.4)
  clusterId?: string | null; // workflow affinity (§2.3)
}

export const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  // Platform parity: priorities are smallint [1, 5]
  userPriority: z.number().int().min(1).max(5),
  toolPriority: z.number().int().min(1).max(5),
  resources: resourcesSchema,
  estimatedDuration: z.number(),
  ttl: z.number(),
  enqueuedAt: z.number(),
  skipCount: z.number(),
  clusterId: z.string().nullable().optional(),
});

export interface ScoredJob extends Job {
  _score: number;
}

export interface RunningJob extends Job {
  startedAt: number;
  remainingDuration: number;
}

export interface CompletedJob extends Job {
  completedAt: number;
}

export interface EvictedJob extends Job {
  evictedAt: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface ScoringConfig {
  orgWeight: number;     // default 10,000
  userWeight: number;    // default 1,000
  toolWeight: number;    // default 100
  agingFactor: number;   // score pts per second of wait
}

export const scoringConfigSchema = z.object({
  orgWeight: z.number(),
  userWeight: z.number(),
  toolWeight: z.number(),
  agingFactor: z.number(),
});

export interface SchedulerConfig {
  topN: number;              // items evaluated per tick (§3.2)
  skipThreshold: number;     // skip_count > X → reservation mode (§3.4)
  backfillMaxRatio: number;  // backfill candidate duration ≤ ratio × blocked (§3.3)
}

export const schedulerConfigSchema = z.object({
  topN: z.number(),
  skipThreshold: z.number(),
  backfillMaxRatio: z.number(),
});

// ── Resource Pools ──────────────────────────────────────────────────────────
// Pool types are dynamic strings from config. Known values: "mason", "mason-gpu"

/**
 * Determines what the user configures for quota limits on this pool.
 *   'cpu' — user sets vCPU; memory (GB) = vCPU × 4; GPU hidden (e.g. mason)
 *   'gpu' — user sets GPU; vCPU = GPU × 4; memory (GB) = vCPU × 4 (e.g. mason-gpu)
 *
 * NOTE: the string token 'cpu' is a UI-facing discriminator for which driver
 * dimension the operator sets. It is NOT the internal unit (cpuMillis).
 * See `src/lib/units.ts` for the model-vs-UI boundary.
 */
export type QuotaType = 'cpu' | 'gpu';

export interface ResourcePool {
  type: string;              // e.g. "mason", "mason-gpu"
  label: string;             // e.g. "CPU Pool (mason)"
  shortLabel: string;        // e.g. "CPU", "GPU" — for compact UI
  color: string;             // e.g. "#4A65DC" — pool accent color
  quotaType: QuotaType;      // what dimension the user configures
  total: Resources;
  reserved: Resources;
  /** Routing predicate: if true, jobs matching this condition go to this pool.
   *  Evaluated in order — first pool whose `routeWhen` returns true wins. */
  routeWhen: (job: { resources: Resources }) => boolean;
}

export const resourcePoolSchema = z.object({
  type: z.string(),
  label: z.string(),
  shortLabel: z.string(),
  color: z.string(),
  quotaType: z.enum(['cpu', 'gpu']),
  total: resourcesSchema,
  reserved: resourcesSchema,
  // routeWhen is a function — not serializable via zod, validated at runtime
});

export interface ClusterConfig {
  pools: ResourcePool[];
}

export const clusterConfigSchema = z.object({
  pools: z.array(resourcePoolSchema),
});

export interface CRMQConfig {
  scoring: ScoringConfig;
  scheduler: SchedulerConfig;
  cluster: ClusterConfig;
  ttlDefault: number;
  /** Active scheduling formula. Defaults to current_weighted for backward compat. */
  formulaType?: 'current_weighted' | 'normalized_weighted_sum' | 'drf_fair_share' | 'balanced_composite' | 'strict_fifo';
  /** Full formula params (when formulaType is set). Falls back to `scoring` for current_weighted. */
  formulaParams?: Record<string, unknown>;
}

export const crmqConfigSchema = z.object({
  scoring: scoringConfigSchema,
  scheduler: schedulerConfigSchema,
  cluster: clusterConfigSchema,
  ttlDefault: z.number(),
});

// ── Scheduler Results ────────────────────────────────────────────────────────

export interface SchedulerResult {
  queue: ScoredJob[];
  active: RunningJob[];
  orgUsage: OrgUsageMap;
  reservMode: boolean;
  reservTarget: string | null;
  dispatched: boolean;
}

export interface CompletionResult {
  stillRunning: RunningJob[];
  completed: CompletedJob[];
  orgUsage: OrgUsageMap;
}

export interface EvictionResult {
  live: Job[];
  evicted: EvictedJob[];
}

/** Per-org, per-pool resource usage. Pool keys are dynamic strings. */
export type OrgUsageMap = Record<string, Record<string, Resources>>;

// ── Virtual Cluster Predictions (§2.3 + §1.5) ───────────────────────────────

export enum BlockingReason {
  NONE                          = 'NONE',
  WAITING_FOR_CPU_CAPACITY      = 'WAITING_FOR_CPU_CAPACITY',
  WAITING_FOR_MEMORY_CAPACITY   = 'WAITING_FOR_MEMORY_CAPACITY',
  WAITING_FOR_GPU_CAPACITY      = 'WAITING_FOR_GPU_CAPACITY',
  WAITING_FOR_MULTI_RESOURCE    = 'WAITING_FOR_MULTI_RESOURCE',
  BLOCKED_BY_ORG_QUOTA          = 'BLOCKED_BY_ORG_QUOTA',
  QUEUED_BEHIND_HIGHER_PRIORITY = 'QUEUED_BEHIND_HIGHER_PRIORITY',
  BLOCKED_BY_RESERVATION_MODE   = 'BLOCKED_BY_RESERVATION_MODE',
  WILL_EXCEED_TTL               = 'WILL_EXCEED_TTL',
  UNKNOWN                       = 'UNKNOWN',
}

export type PredictionStatus = 'WAITING' | 'PREDICTED' | 'WILL_EXPIRE' | 'UNPREDICTABLE';

export interface Prediction {
  delta: number | null;              // seconds until estimated start
  estimatedStartTime: number | null;
  blockingReason: BlockingReason;
  variance: number | null;           // ±% confidence
  queueRank: number;
  status: PredictionStatus;
}

export type PredictionMap = Record<string, Prediction>;

export interface FormattedPrediction {
  label: string;
  window?: string;
  detail: string;
  css: string;
}

export interface ReasonLabel {
  label: string;
  icon: string;
  css: string;
}

// ── Log Entry ────────────────────────────────────────────────────────────────

export type LogType = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  t: number;
  msg: string;
  type: LogType;
}

// ── UI State ─────────────────────────────────────────────────────────────────

export interface SimulatorState {
  cfg: CRMQConfig;
  orgs: Org[];
  simTime: number;
  running: boolean;
  speed: number;
  queue: Job[];
  active: RunningJob[];
  completed: CompletedJob[];
  evicted: EvictedJob[];
  logs: LogEntry[];
  reservMode: boolean;
  reservTarget: string | null;
  orgUsage: OrgUsageMap;
  predictions: PredictionMap;
}

// ── Pool Routing ─────────────────────────────────────────────────────────────

/**
 * Route a job to the correct pool based on the config's `routeWhen` predicates.
 * Pools are evaluated in order — first match wins.
 * Falls back to the first pool if no predicate matches.
 */
export const getJobPoolType = (job: { resources: Resources }, config: CRMQConfig): string => {
  for (const pool of config.cluster.pools) {
    if (pool.routeWhen(job)) return pool.type;
  }
  return config.cluster.pools[0]?.type ?? 'unknown';
};

/**
 * Look up pool display metadata from config.
 * Returns defaults if pool not found.
 */
export const getPoolMeta = (config: CRMQConfig, poolType: string) => {
  const pool = config.cluster.pools.find(p => p.type === poolType);
  return {
    label: pool?.label ?? poolType,
    shortLabel: pool?.shortLabel ?? poolType,
    color: pool?.color ?? '#6B7280',
  };
};
