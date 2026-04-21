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

/**
 * Per-pool resource requests. Keys are pool `type` strings (e.g. "mason",
 * "mason-gpu"); each value is the slice of resources the job requests from
 * that pool. A job participates in every pool whose key is present here —
 * keys are the routing signal (§1.4 platform parity: `ResourcesByType`).
 *
 * Invariants:
 *   - at least one key MUST be present (a job with no resource request is not valid)
 *   - each `Resources` slice is non-negative
 *   - a pool type not listed in the map is untouched by the job
 */
export type ResourcesByType = Record<string, Resources>;

export const resourcesByTypeSchema = z.record(z.string(), resourcesSchema);

export interface Job {
  id: string;
  name: string;
  orgId: string;
  userPriority: number;  // 1–5
  toolPriority: number;  // 1–5
  /**
   * Per-pool resource request map (§1.4 platform parity).
   * Single-pool jobs contain exactly one key; multi-pool jobs contain two or
   * more. Keys MUST correspond to `ResourcePool.type` entries in the active
   * config. The cpuMillis-weighted load ratio in scoring formulas is computed
   * across every pool in this map.
   */
  resources: ResourcesByType;
  estimatedDuration: number; // seconds
  ttl: number;               // seconds — time-to-live in queue (§1.2)
  enqueuedAt: number;        // sim-time when enqueued
  skipCount: number;         // times skipped by scheduler (§3.4) — retained for diagnostics
  /**
   * Sim-time of the first capacity-gate failure. Used by the wall-clock
   * reservation trigger (§3.4 platform parity): reservation mode activates
   * when `now - firstGatedAt >= scheduler.reservationThresholdSec`.
   * Cleared (undefined) whenever the job is admitted or when it clears Gate 2
   * without being skipped.
   */
  firstGatedAt?: number | null;
  clusterId?: string | null; // workflow affinity (§2.3)
}

export const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  // Platform parity: priorities are smallint [1, 5]
  userPriority: z.number().int().min(1).max(5),
  toolPriority: z.number().int().min(1).max(5),
  resources: resourcesByTypeSchema,
  estimatedDuration: z.number(),
  ttl: z.number(),
  enqueuedAt: z.number(),
  skipCount: z.number(),
  firstGatedAt: z.number().nullable().optional(),
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
  topN: number;                      // items evaluated per tick (§3.2)
  /**
   * Retained for diagnostics and legacy displays.
   * Reservation-mode activation is driven by `reservationThresholdSec`
   * (wall-clock, platform parity), not by skipCount anymore.
   */
  skipThreshold: number;
  /**
   * Wall-clock seconds a head-of-queue job must remain capacity-gated before
   * reservation mode engages (§3.4). Platform parity: 600s (20s cron × 30 skips).
   */
  reservationThresholdSec: number;
  backfillMaxRatio: number;          // backfill candidate duration ≤ ratio × blocked (§3.3)
}

export const schedulerConfigSchema = z.object({
  topN: z.number(),
  skipThreshold: z.number(),
  reservationThresholdSec: z.number().min(0),
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
  /**
   * External (non-CRMQ) consumers of the same physical pool — e.g. other
   * tenants or jobs booked outside the queue. Subtracted from `total`
   * alongside `reserved` when computing the effective load-ratio denominator
   * (platform parity: `availableDimension(total, externalUsage, reserved)`).
   * Defaults to zero in the simulator; platform supplies real values.
   */
  externalUsage: Resources;
  /**
   * Optional coupling to a shared account-level resource (§3.4).
   * When set, the pool's effective capacity is bounded by the sibling
   * pools that share the same `accountResourceId` — see
   * `CRMQConfig.accountResources`.
   */
  accountResourceId?: string;
  /**
   * Single-slice routing predicate. Given one `Resources` slice, returns
   * true if that slice belongs to this pool type. Used by authoring helpers
   * (e.g. the "Add job" modal) to auto-assign a single-pool request to the
   * correct pool. Multi-pool jobs bypass this — they route explicitly via
   * the keys of `Job.resources`.
   */
  routeWhen: (res: Resources) => boolean;
}

export const resourcePoolSchema = z.object({
  type: z.string(),
  label: z.string(),
  shortLabel: z.string(),
  color: z.string(),
  quotaType: z.enum(['cpu', 'gpu']),
  total: resourcesSchema,
  reserved: resourcesSchema,
  externalUsage: resourcesSchema,
  accountResourceId: z.string().optional(),
  // routeWhen is a function — not serializable via zod, validated at runtime
});

export interface ClusterConfig {
  pools: ResourcePool[];
}

export const clusterConfigSchema = z.object({
  pools: z.array(resourcePoolSchema),
});

// ── Account Resources (§3.4 platform parity) ────────────────────────────────

/**
 * AccountResource — a shared capacity ceiling that multiple pools draw from
 * (analog of `account_resources` / `cluster_resources` in the platform).
 *
 * When two or more pools set `accountResourceId = <id>`, all of their live
 * usage is aggregated against this resource's `totalCapacity` (minus
 * `externalUsage`). Allocating in one coupled pool therefore shrinks the
 * effective headroom of its siblings on the coupled axis.
 *
 * If `accountResourceId` is unset on a pool, the pool behaves independently
 * (no coupling). Default simulator config ships with NO account resources —
 * coupling is opt-in.
 */
export interface AccountResource {
  id: string;
  label: string;
  /** Shared capacity ceiling. Dimensions are the usual cpuMillis/memoryMiB/gpu. */
  totalCapacity: Resources;
  /** External (non-CRMQ) usage against this shared ceiling, like `pool.externalUsage`. */
  externalUsage: Resources;
}

export const accountResourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  totalCapacity: resourcesSchema,
  externalUsage: resourcesSchema,
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
  /**
   * Optional account-level shared-capacity resources (§3.4). Empty/undefined
   * means each pool runs independently — the default.
   */
  accountResources?: AccountResource[];
}

export const crmqConfigSchema = z.object({
  scoring: scoringConfigSchema,
  scheduler: schedulerConfigSchema,
  cluster: clusterConfigSchema,
  ttlDefault: z.number(),
  accountResources: z.array(accountResourceSchema).optional(),
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

// ── Pool Routing & Multi-Pool Helpers ───────────────────────────────────────

/** Zero-valued Resources slice. */
export const ZERO_RESOURCES: Resources = Object.freeze({
  cpuMillis: 0,
  memoryMiB: 0,
  gpu: 0,
}) as Resources;

/**
 * Pool types the job touches. Keys of `Job.resources` ARE the routing.
 * For a valid job this returns at least one entry.
 */
export const jobPools = (job: { resources: ResourcesByType }): string[] =>
  Object.keys(job.resources);

/**
 * Resource slice the job requests from a specific pool, or zeros if the
 * job doesn't touch that pool.
 */
export const jobResInPool = (
  job: { resources: ResourcesByType },
  poolType: string,
): Resources => job.resources[poolType] ?? { ...ZERO_RESOURCES };

/**
 * Aggregate resource request summed across every pool the job touches.
 * Used for CPU-hours accounting, display totals, and "does this job fit
 * anywhere" sanity checks.
 */
export const jobTotalResources = (
  job: { resources: ResourcesByType },
): Resources => {
  let cpuMillis = 0;
  let memoryMiB = 0;
  let gpu = 0;
  for (const key of Object.keys(job.resources)) {
    const r = job.resources[key];
    cpuMillis += r.cpuMillis;
    memoryMiB += r.memoryMiB;
    gpu += r.gpu;
  }
  return { cpuMillis, memoryMiB, gpu };
};

/**
 * Pick the "primary" pool for a job — the first key in its resource map.
 * For single-pool jobs this is the only pool; for multi-pool jobs it's
 * the first one listed (stable since Record key order preserves insertion).
 * Used for legacy single-pool display paths.
 */
export const getJobPoolType = (
  job: { resources: ResourcesByType },
  config: CRMQConfig,
): string => {
  const keys = Object.keys(job.resources);
  if (keys.length > 0) return keys[0];
  return config.cluster.pools[0]?.type ?? 'unknown';
};

/**
 * Pick the pool for a single `Resources` slice using each pool's
 * `routeWhen` predicate. Pools are evaluated in order — first match wins.
 * Used by authoring flows (e.g. Add-Job modal) to assign a resource
 * slice to a pool when the user hasn't picked one explicitly.
 */
export const routeSingleResource = (
  res: Resources,
  config: CRMQConfig,
): string => {
  for (const pool of config.cluster.pools) {
    if (pool.routeWhen(res)) return pool.type;
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
