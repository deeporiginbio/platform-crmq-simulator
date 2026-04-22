/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Traffic Model Generators
 * ============================================
 * Implements the traffic models recommended by §5.4 of the research report:
 *
 *   1. Uniform     — constant inter-arrival time (baseline)
 *   2. Poisson     — exponential inter-arrivals, memoryless (algorithm validation)
 *   3. MMPP        — Markov-Modulated Poisson Process (realistic burstiness)
 *   4. Burst       — all jobs arrive at once (stress test)
 *
 * Job sizes can be drawn from:
 *   - Fixed     — all jobs identical
 *   - Uniform   — uniformly distributed between min/max
 *   - Pareto    — heavy-tailed (§5.4): 80% small, 20% consume 80% of resources
 *
 * All generators are deterministic given a seed (via a simple LCG PRNG).
 * This enables reproducible benchmark runs and paired comparisons (§5.5).
 */

import type { Resources, ResourcesByType, Org } from '../types';
import { cpuMillisFromVcpu, memoryMiBFromGb } from '../units';

// ── PRNG (Linear Congruential Generator) ──────────────────────────────────
// Deterministic, seedable, fast. Good enough for simulation.

export class SeededRandom {
  private state: number;

  constructor(seed: number = 42) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }

  /** Returns a float in [0, 1) */
  next(): number {
    // Park-Miller LCG
    this.state = (this.state * 16807) % 2147483647;
    return (this.state - 1) / 2147483646;
  }

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a float in [min, max) */
  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Exponential random variable with rate lambda */
  exponential(lambda: number): number {
    return -Math.log(1 - this.next()) / lambda;
  }

  /** Pareto random variable: X = x_min / U^(1/alpha), U ~ Uniform(0,1) */
  pareto(xMin: number, alpha: number): number {
    const u = this.next();
    return xMin / Math.pow(u, 1 / alpha);
  }

  /** Pick a random element from an array */
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

// ── Generated Job (before assigning sim-time IDs) ─────────────────────────

export interface GeneratedJob {
  name: string;
  orgId: string;
  userPriority: number;
  toolPriority: number;
  resources: Resources;
  /**
   * Optional multi-pool resource request (§1.4 `ResourcesByType`). When
   * present the DES engine uses this directly and skips single-pool routing;
   * `resources` is still populated (set to the aggregate across pools) so
   * existing metrics code that expects the flat shape keeps working.
   */
  resourcesByType?: ResourcesByType;
  estimatedDuration: number;
  ttl: number;
  arrivalTime: number;   // sim-time when this job arrives
}

// ── Arrival Patterns ──────────────────────────────────────────────────────

export type ArrivalPattern =
  | { type: 'uniform'; ratePerMinute: number }
  | { type: 'poisson'; lambdaPerMinute: number }
  | { type: 'burst'; count: number; atTime: number }
  | { type: 'mmpp'; states: MMPPState[]; transitionInterval: number }
  | { type: 'periodic_mix'; templates: PeriodicJobTemplate[] };

export interface MMPPState {
  label: string;          // e.g. "quiet", "busy", "peak"
  lambdaPerMinute: number;
  weight: number;         // relative probability of transitioning TO this state
}

/**
 * A deterministic job template that arrives at a fixed interval.
 * Used for scripted workloads (e.g. the 24h full simulation report).
 */
export interface PeriodicJobTemplate {
  name: string;
  orgId: string;
  /**
   * Single-pool resource request. Routed to a pool via the config's
   * `routeWhen` predicates in the DES engine. Ignored when
   * `resourcesByType` is set.
   */
  cpuMillis: number;
  memoryMiB: number;
  gpu: number;
  /**
   * Optional multi-pool request (§1.4 platform parity). When present the
   * job holds capacity in every listed pool simultaneously; both capacity
   * gates (Gate 2) and org quotas (Gate 1) must pass for each pool slice.
   * Keys are pool `type` strings (e.g. `"mason"`, `"mason-gpu"`). Takes
   * precedence over the single-pool `cpuMillis/memoryMiB/gpu` fields.
   */
  resourcesByType?: ResourcesByType;
  durationSeconds: number;
  intervalSeconds: number;   // one job every N seconds
  userPriority: number;
  toolPriority: number;
}

/**
 * Generate arrival times for the given pattern over `durationSeconds` of sim-time.
 */
export const generateArrivalTimes = (
  pattern: ArrivalPattern,
  durationSeconds: number,
  rng: SeededRandom,
  startTime: number = 0,
): number[] => {
  const times: number[] = [];

  switch (pattern.type) {
    case 'uniform': {
      const intervalSec = 60 / pattern.ratePerMinute;
      let t = startTime;
      while (t < startTime + durationSeconds) {
        times.push(t);
        t += intervalSec;
      }
      break;
    }

    case 'poisson': {
      const lambdaSec = pattern.lambdaPerMinute / 60;
      let t = startTime;
      while (t < startTime + durationSeconds) {
        const interArrival = rng.exponential(lambdaSec);
        t += interArrival;
        if (t < startTime + durationSeconds) {
          times.push(t);
        }
      }
      break;
    }

    case 'burst': {
      for (let i = 0; i < pattern.count; i++) {
        // Small jitter to avoid exact same time
        times.push(pattern.atTime + rng.nextFloat(0, 2));
      }
      break;
    }

    case 'mmpp': {
      const states = pattern.states;
      if (states.length === 0) break;

      // Start in a random state weighted by probability
      const totalWeight = states.reduce((a, s) => a + s.weight, 0);
      let stateIdx = 0;
      {
        let r = rng.next() * totalWeight;
        for (let i = 0; i < states.length; i++) {
          r -= states[i].weight;
          if (r <= 0) { stateIdx = i; break; }
        }
      }

      let t = startTime;
      let stateEndTime = startTime + pattern.transitionInterval;

      while (t < startTime + durationSeconds) {
        // Transition check
        if (t >= stateEndTime) {
          // Transition to a new state (weighted random, excluding current)
          const candidates = states.filter((_, i) => i !== stateIdx);
          if (candidates.length > 0) {
            const cw = candidates.reduce((a, s) => a + s.weight, 0);
            let r = rng.next() * cw;
            for (let i = 0; i < candidates.length; i++) {
              r -= candidates[i].weight;
              if (r <= 0) {
                stateIdx = states.indexOf(candidates[i]);
                break;
              }
            }
          }
          stateEndTime = t + pattern.transitionInterval;
        }

        const lambdaSec = states[stateIdx].lambdaPerMinute / 60;
        if (lambdaSec <= 0) {
          // Zero rate — skip ahead to next state transition
          t = stateEndTime;
          continue;
        }
        const interArrival = rng.exponential(lambdaSec);
        t += interArrival;
        if (t < startTime + durationSeconds && t < stateEndTime) {
          times.push(t);
        } else if (t >= stateEndTime) {
          // Force transition on next iteration
          t = stateEndTime;
        }
      }
      break;
    }
  }

  return times.sort((a, b) => a - b);
};

// ── Job Size Distributions ────────────────────────────────────────────────

export type JobSizeDistribution =
  | { type: 'fixed'; cpu: number; memory: number; gpu: number; duration: number }
  | { type: 'uniform'; cpuRange: [number, number]; memoryRange: [number, number]; gpuRange: [number, number]; durationRange: [number, number] }
  | { type: 'pareto'; alpha: number; cpuMin: number; memoryMin: number; gpuMin: number; durationMin: number }
  | { type: 'mixed'; small: number; medium: number; large: number };

/**
 * The 'mixed' distribution from §5.3: 80% small, 15% medium, 5% large.
 * Each class has its own resource ranges.
 */
/**
 * Mixed workload classes calibrated for a ~1362-CPU cluster.
 * Small jobs fill gaps (backfill candidates), large jobs create contention.
 */
const MIXED_CLASSES = {
  small:  { cpuRange: [4, 16]   as [number, number], memRange: [16, 64]   as [number, number], gpuRange: [0, 0] as [number, number], durRange: [60, 180]     as [number, number] },
  medium: { cpuRange: [16, 64]  as [number, number], memRange: [64, 256]  as [number, number], gpuRange: [0, 2] as [number, number], durRange: [180, 600]    as [number, number] },
  large:  { cpuRange: [64, 256] as [number, number], memRange: [256, 1024] as [number, number], gpuRange: [2, 8] as [number, number], durRange: [600, 3600]  as [number, number] },
};

export const generateJobSize = (
  dist: JobSizeDistribution,
  rng: SeededRandom,
): { resources: Resources; duration: number } => {
  switch (dist.type) {
    case 'fixed':
      return {
        resources: {
          cpuMillis: cpuMillisFromVcpu(dist.cpu),
          memoryMiB: memoryMiBFromGb(dist.memory),
          gpu: dist.gpu,
        },
        duration: dist.duration,
      };

    case 'uniform':
      return {
        resources: {
          cpuMillis: cpuMillisFromVcpu(
            rng.nextInt(dist.cpuRange[0], dist.cpuRange[1])
          ),
          memoryMiB: memoryMiBFromGb(
            rng.nextInt(dist.memoryRange[0], dist.memoryRange[1])
          ),
          gpu: rng.nextInt(dist.gpuRange[0], dist.gpuRange[1]),
        },
        duration: rng.nextInt(dist.durationRange[0], dist.durationRange[1]),
      };

    case 'pareto': {
      const cpu = Math.round(rng.pareto(dist.cpuMin, dist.alpha));
      const memory = Math.round(rng.pareto(dist.memoryMin, dist.alpha));
      const gpu = Math.round(rng.pareto(dist.gpuMin, dist.alpha));
      const duration = Math.round(rng.pareto(dist.durationMin, dist.alpha));
      return {
        resources: {
          cpuMillis: cpuMillisFromVcpu(Math.min(cpu, 128)),
          memoryMiB: memoryMiBFromGb(Math.min(memory, 512)),
          gpu: Math.min(gpu, 16),
        },
        duration: Math.min(duration, 28800),
      };
    }

    case 'mixed': {
      // Weighted random: small%, medium%, large%
      const r = rng.next() * 100;
      const cls = r < dist.small ? MIXED_CLASSES.small
        : r < dist.small + dist.medium ? MIXED_CLASSES.medium
        : MIXED_CLASSES.large;
      return {
        resources: {
          cpuMillis: cpuMillisFromVcpu(
            rng.nextInt(cls.cpuRange[0], cls.cpuRange[1])
          ),
          memoryMiB: memoryMiBFromGb(
            rng.nextInt(cls.memRange[0], cls.memRange[1])
          ),
          gpu: rng.nextInt(cls.gpuRange[0], cls.gpuRange[1]),
        },
        duration: rng.nextInt(cls.durRange[0], cls.durRange[1]),
      };
    }
  }
};

// ── Job Name Templates ────────────────────────────────────────────────────

const JOB_NAMES = [
  'Ligand Prep', 'Docking Run', 'MD Simulation', 'ADMET Prediction',
  'Pocket Finding', 'Conformer Gen', 'ML Training', 'Data Ingestion',
  'Scoring Pipeline', 'FEP Calculation', 'Homology Modeling', 'Virtual Screen',
  'Fragment Growing', 'Pharmacophore Search', 'QSAR Model', 'Retrosynthesis',
];

// ── Workload Generator ────────────────────────────────────────────────────

export interface WorkloadConfig {
  /** Duration of the workload in sim-seconds */
  durationSeconds: number;
  /** How jobs arrive */
  arrivalPattern: ArrivalPattern;
  /** How job sizes are distributed */
  sizeDistribution: JobSizeDistribution;
  /** Available orgs — jobs are distributed among them */
  orgs: Org[];
  /** Default TTL for generated jobs */
  ttlDefault: number;
  /** Random seed for reproducibility */
  seed: number;
}

/**
 * Generate a full workload: a list of jobs with arrival times, sizes, and org assignments.
 *
 * For `periodic_mix` arrival patterns, jobs are generated deterministically from templates
 * at fixed intervals — no random arrival/size generation. This enables exact reproduction
 * of scripted workloads (e.g. the 24h full simulation report).
 */
export const generateWorkload = (wc: WorkloadConfig): GeneratedJob[] => {
  const rng = new SeededRandom(wc.seed);

  // ── Periodic mix: template-based generation with small jitter ──────────
  // Each template repeats at a fixed interval, but small random jitter (±5%
  // of the interval) is applied to arrival times using the seeded RNG.
  // This makes replications with different seeds produce meaningfully
  // different workloads for statistical comparison (paired t-tests, CIs),
  // while preserving the overall workload characteristics.
  if (wc.arrivalPattern.type === 'periodic_mix') {
    const templates = wc.arrivalPattern.templates;
    const jobs: GeneratedJob[] = [];
    let idx = 0;

    for (const tpl of templates) {
      let t = 0;
      while (t < wc.durationSeconds) {
        // ±5% jitter on arrival time — enough for statistical variation,
        // small enough to preserve the scripted workload shape
        const jitter = rng.nextFloat(
          -tpl.intervalSeconds * 0.05,
          tpl.intervalSeconds * 0.05,
        );
        const arrivalTime = Math.max(0, t + jitter);

        const duration = tpl.durationSeconds;
        // Aggregate across pools for the flat `resources` field so downstream
        // metrics (utilization, cost) that read `GeneratedJob.resources`
        // still see totals. `resourcesByType` carries the per-pool slices
        // the scheduler actually admits against.
        let flat: Resources;
        let byType: ResourcesByType | undefined;
        if (tpl.resourcesByType) {
          byType = {};
          let c = 0, m = 0, g = 0;
          for (const [pool, slice] of Object.entries(tpl.resourcesByType)) {
            byType[pool] = { ...slice };
            c += slice.cpuMillis; m += slice.memoryMiB; g += slice.gpu;
          }
          flat = { cpuMillis: c, memoryMiB: m, gpu: g };
        } else {
          flat = {
            cpuMillis: tpl.cpuMillis,
            memoryMiB: tpl.memoryMiB,
            gpu: tpl.gpu,
          };
        }
        jobs.push({
          name: `${tpl.name} #${++idx}`,
          orgId: tpl.orgId,
          userPriority: tpl.userPriority,
          toolPriority: tpl.toolPriority,
          resources: flat,
          ...(byType ? { resourcesByType: byType } : {}),
          estimatedDuration: duration,
          ttl: wc.ttlDefault,
          arrivalTime,
        });
        t += tpl.intervalSeconds;
      }
    }

    // Sort by arrival time (templates interleave)
    return jobs.sort((a, b) => a.arrivalTime - b.arrivalTime);
  }

  // ── Standard stochastic generation ─────────────────────────────────────
  // Generate arrival times
  const arrivalTimes = generateArrivalTimes(wc.arrivalPattern, wc.durationSeconds, rng);

  // Generate jobs
  const jobs: GeneratedJob[] = arrivalTimes.map((arrivalTime, i) => {
    const { resources, duration } = generateJobSize(wc.sizeDistribution, rng);
    const org = rng.pick(wc.orgs);
    const name = `${rng.pick(JOB_NAMES)} #${i + 1}`;
    const userPriority = rng.nextInt(1, 5);
    const toolPriority = rng.nextInt(1, 5);
    const ttl = wc.ttlDefault;

    return {
      name,
      orgId: org.id,
      userPriority,
      toolPriority,
      resources,
      estimatedDuration: duration,
      ttl,
      arrivalTime,
    };
  });

  return jobs;
};

// ── Preset Scenarios (§5.3) ───────────────────────────────────────────────

export interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  phase: 1 | 2 | 3 | 4 | 5 | 6;
  workloadConfig: Omit<WorkloadConfig, 'orgs' | 'ttlDefault'>;
  /**
   * When true, this scenario validates scheduler infrastructure
   * (dispatching, backfill, queue drain) rather than formula
   * differentiation. Available in benchmarks but hidden from the
   * visual simulator's scenario picker.
   */
  benchmarkOnly?: boolean;
}

/**
 * Workload sizing notes:
 *   Default cluster: mason = 1362 usable CPU, mason-gpu = 767 usable CPU / 192 GPU
 *   Org quotas: deeporigin = 1,364 CPU, org-beta = 384, org-gamma = 384
 *
 *   For stochastic scenarios, use Little's Law with E[CPU × duration]:
 *     utilization = λ × E[CPU × duration] / pool_capacity
 *   (NOT λ × E[CPU] × E[duration] — job size and duration are correlated
 *    in mixed distributions, so the product matters.)
 *
 *   For periodic_mix, concurrent = duration / interval per template:
 *     demand = concurrent × cpu_per_job, capped by min(org_quota, pool)
 *
 *   Formula-testing scenarios use periodic_mix with all orgs under quota
 *   so the pool is the sole bottleneck and scoring determines dispatch order.
 */

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  // Phase 1 — MVP
  // Phase 1 — Core Infrastructure (benchmarkOnly)
  // These validate scheduler mechanics (dispatching, backfill, queue
  // drain) with random org assignment. They do NOT differentiate
  // scoring formulas — FIFO wins because there's no real contention.
  // Kept for regression testing of the scheduling engine itself.
  {
    id: 'steady-state',
    name: 'Steady State',
    description:
      '[Core] Sustained 30 jobs/min, 16-48 CPU, 2-min avg'
      + ' — validates dispatch + queue drain at ~80% util.'
      + ' Random org assignment; does not test formula logic.',
    phase: 1,
    benchmarkOnly: true,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 30 },
      sizeDistribution: {
        type: 'uniform',
        cpuRange: [16, 48],
        memoryRange: [64, 192],
        gpuRange: [0, 0],
        durationRange: [90, 180],
      },
      seed: 42,
    },
  },
  {
    id: 'burst-traffic',
    name: 'Burst Traffic',
    description:
      '[Core] 200 large jobs at once — validates queue'
      + ' saturation and drain. Random org assignment;'
      + ' does not test formula logic.',
    phase: 1,
    benchmarkOnly: true,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'burst', count: 200, atTime: 0 },
      sizeDistribution: {
        type: 'uniform',
        cpuRange: [16, 64],
        memoryRange: [64, 256],
        gpuRange: [0, 0],
        durationRange: [120, 300],
      },
      seed: 123,
    },
  },
  {
    id: 'mixed-workload',
    name: 'Mixed Workload',
    description:
      '[Core] 80% small + 15% medium + 5% large at'
      + ' 25 jobs/min — validates backfill effectiveness.'
      + ' Random org assignment; does not test formula logic.',
    phase: 1,
    benchmarkOnly: true,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 25 },
      sizeDistribution: {
        type: 'mixed', small: 80, medium: 15, large: 5,
      },
      seed: 456,
    },
  },

  // ── Phase 1 — Formula Validation ───────────────────────────────
  // These scenarios ARE selectable and specifically test formula
  // differentiation under realistic multi-tenant conditions.

  {
    id: 'sustained-overload-aging',
    name: 'Sustained Overload Aging Test',
    description:
      'Critical for Balanced Composite: 3 orgs at'
      + ' ~117% pool capacity for 8h — all under quota,'
      + ' pool is the bottleneck. Diverse job types per'
      + ' org exercise the full 6h aging curve.',
    phase: 1,
    workloadConfig: {
      durationSeconds: 28800, // 8 hours
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // ── deeporigin (quota 1,364 CPU) ──────────────
          // Large compute: 96 CPU × 9 concurrent = 864
          // Long-running (6h), high priority — dominates
          // pool; formula decides vs other orgs' jobs
          {
            name: 'DO-large-96cpu',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(96), memoryMiB: memoryMiBFromGb(384),
            gpu: 0,
            durationSeconds: 21600,
            intervalSeconds: 2400,
            userPriority: 4,
            toolPriority: 4,
          },
          // Small background: 8 CPU × 6 = 48 CPU
          // Low priority — tests aging boost for small
          {
            name: 'DO-bg-8cpu',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),
            gpu: 0,
            durationSeconds: 1800,
            intervalSeconds: 300,
            userPriority: 1,
            toolPriority: 1,
          },
          // DO total: 864 + 48 = 912 (< 1,364 ✓)

          // ── org-beta (quota 384 CPU) ──────────────────
          // Medium: 32 CPU × 10 concurrent = 320 CPU
          {
            name: 'Beta-med-32cpu',
            orgId: 'org-beta',
            cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),
            gpu: 0,
            durationSeconds: 7200,
            intervalSeconds: 720,
            userPriority: 3,
            toolPriority: 3,
          },
          // Small fills: 4 CPU × 5 = 20 CPU
          {
            name: 'Beta-small-4cpu',
            orgId: 'org-beta',
            cpuMillis: cpuMillisFromVcpu(4), memoryMiB: memoryMiBFromGb(16),
            gpu: 0,
            durationSeconds: 900,
            intervalSeconds: 180,
            userPriority: 1,
            toolPriority: 2,
          },
          // Beta total: 320 + 20 = 340 (< 384 ✓)

          // ── org-gamma (quota 384 CPU) ─────────────────
          // Medium-large: 24 CPU × 9 = 216 CPU
          // 3h duration — mid-range aging (1-3h)
          {
            name: 'Gamma-med-24cpu',
            orgId: 'org-gamma',
            cpuMillis: cpuMillisFromVcpu(24), memoryMiB: memoryMiBFromGb(96),
            gpu: 0,
            durationSeconds: 10800,
            intervalSeconds: 1200,
            userPriority: 2,
            toolPriority: 3,
          },
          // Small: 16 CPU × 7.5 = 120 CPU
          {
            name: 'Gamma-small-16cpu',
            orgId: 'org-gamma',
            cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),
            gpu: 0,
            durationSeconds: 3600,
            intervalSeconds: 480,
            userPriority: 4,
            toolPriority: 2,
          },
          // Gamma total: 216 + 120 = 336 (< 384 ✓)
        ],
        // Grand total: DO 912 + Beta 340 + Gamma 336
        //   = 1,588 CPU → 117% of 1,362 pool
        // ALL orgs under quota → pool sole bottleneck.
        // Diverse sizes + priorities → formula ranking
        // determines which org's jobs dispatch first.
        // Long durations (1-6h) exercise aging curve.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0,
        gpu: 0,
        duration: 0,
      },
      seed: 1337,
    },
  },
  {
    id: 'multi-tenant-steady-state',
    name: 'Multi-Tenant Steady State',
    description:
      'MVP replacement: 3 orgs at ~113% pool capacity,'
      + ' all under quota. Mixed job sizes per org create'
      + ' formula-sensitive dispatch ordering.',
    phase: 1,
    workloadConfig: {
      durationSeconds: 3600, // 1 hour
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // ── deeporigin (quota 1,364 CPU) ──────────────
          // Large: 64 CPU, 15min, every 75s
          // → 12 concurrent × 64 = 768 CPU
          {
            name: 'DO-large-64cpu',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256),
            gpu: 0,
            durationSeconds: 900,
            intervalSeconds: 75,
            userPriority: 3,
            toolPriority: 4,
          },
          // Small low-pri: 8 CPU, 5min, every 35s
          // → 8.6 concurrent × 8 = 69 CPU
          {
            name: 'DO-small-8cpu',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),
            gpu: 0,
            durationSeconds: 300,
            intervalSeconds: 35,
            userPriority: 1,
            toolPriority: 1,
          },
          // DO total: 768 + 69 = 837 (< 1,364 ✓)

          // ── org-beta (quota 384 CPU) ──────────────────
          // Medium: 16 CPU, 8min, every 60s
          // → 8 concurrent × 16 = 128 CPU
          {
            name: 'Beta-med-16cpu',
            orgId: 'org-beta',
            cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),
            gpu: 0,
            durationSeconds: 480,
            intervalSeconds: 60,
            userPriority: 2,
            toolPriority: 3,
          },
          // Large high-pri: 48 CPU, 20min, every 4min
          // → 5 concurrent × 48 = 240 CPU
          {
            name: 'Beta-large-48cpu',
            orgId: 'org-beta',
            cpuMillis: cpuMillisFromVcpu(48), memoryMiB: memoryMiBFromGb(192),
            gpu: 0,
            durationSeconds: 1200,
            intervalSeconds: 240,
            userPriority: 5,
            toolPriority: 4,
          },
          // Beta total: 128 + 240 = 368 (< 384 ✓)

          // ── org-gamma (quota 384 CPU) ─────────────────
          // Medium: 32 CPU, 12min, every 90s
          // → 8 concurrent × 32 = 256 CPU
          {
            name: 'Gamma-med-32cpu',
            orgId: 'org-gamma',
            cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),
            gpu: 0,
            durationSeconds: 720,
            intervalSeconds: 90,
            userPriority: 3,
            toolPriority: 3,
          },
          // Small fills: 8 CPU, 5min, every 30s
          // → 10 concurrent × 8 = 80 CPU
          {
            name: 'Gamma-small-8cpu',
            orgId: 'org-gamma',
            cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),
            gpu: 0,
            durationSeconds: 300,
            intervalSeconds: 30,
            userPriority: 4,
            toolPriority: 2,
          },
          // Gamma total: 256 + 80 = 336 (< 384 ✓)
        ],
        // Grand total: DO 837 + Beta 368 + Gamma 336
        //   = 1,541 CPU → 113% of 1,362 pool.
        // All under quota → pool is the bottleneck.
        // Each org has high-pri + low-pri mix →
        // formula ranking affects dispatch order.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0,
        gpu: 0,
        duration: 0,
      },
      seed: 1338,
    },
  },

  // Phase 2 — Advanced
  {
    id: 'multi-tenant-competition',
    name: 'Multi-Tenant Competition',
    description: 'Asymmetric 3-org contention: deeporigin (few large), org-beta (many small), org-gamma (medium) — all push quotas, tests org-level fairness',
    phase: 2,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin: large 64-CPU jobs every 30s (2/min)
          // 180s / 30s = 6 concurrent × 64 = 384 CPU (~28% of quota)
          // High priority org (3) with high-value jobs
          { name: 'DO-large-64cpu',     orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256),  gpu: 0, durationSeconds: 180, intervalSeconds: 30,  userPriority: 4, toolPriority: 4 },
          // org-beta: small 4-CPU jobs every 2s (30/min)
          // 120s / 2s = 60 concurrent × 4 = 240 CPU (within 384 quota)
          // Floods queue with volume, low priority org (2)
          { name: 'Beta-small-4cpu',    orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(4), memoryMiB: memoryMiBFromGb(16),   gpu: 0, durationSeconds: 120, intervalSeconds: 2,   userPriority: 2, toolPriority: 2 },
          // org-gamma: medium 32-CPU jobs every 10s (6/min)
          // 300s / 10s = 30 concurrent × 32 = 960 CPU demand,
          // but quota caps at 12 concurrent (384 CPU)
          // Lowest priority org (1), creates real quota contention
          { name: 'Gamma-med-32cpu',    orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 300, intervalSeconds: 10,  userPriority: 3, toolPriority: 3 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 1001,
    },
  },
  {
    id: 'gpu-scarcity',
    name: 'GPU Scarcity',
    description: 'GPU jobs at 8 jobs/min with 4-16 GPU each — 192 GPU exhausted fast',
    phase: 2,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 8 },
      sizeDistribution: { type: 'uniform', cpuRange: [16, 64], memoryRange: [64, 256], gpuRange: [4, 16], durationRange: [300, 900] },
      seed: 2002,
    },
  },
  {
    id: 'head-of-line-blocking',
    name: 'Head-of-Line Blocking',
    description: 'Mix of 95% small + 5% cluster-sized jobs — tests reservation mode + backfill',
    phase: 2,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 20 },
      sizeDistribution: { type: 'mixed', small: 95, medium: 4, large: 1 },
      seed: 3003,
    },
  },

  {
    id: 'full-24h-simulation',
    name: '24h Full Simulation',
    description: '24h deterministic mix: 3 orgs each submit medium-large jobs at ~105% cluster capacity — formula decides cross-org priority under sustained overload',
    phase: 2,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // NOTE: orgIds must match DEFAULT_ORGS (deeporigin, org-beta, org-gamma).
          //
          // Each org submits medium-large jobs that collectively exceed pool capacity.
          // The formula must decide cross-org priority when not all jobs can run.
          //
          // deeporigin: 96 CPU, 4h, every 45min = 5.3 concurrent × 96 = 512 CPU
          { name: 'DO-large-96cpu',     orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(96), memoryMiB: memoryMiBFromGb(384), gpu: 0, durationSeconds: 14400, intervalSeconds: 2700, userPriority: 3, toolPriority: 4 },
          // org-beta: 48 CPU, 2h, every 15min = 8 concurrent × 48 = 384 CPU (= quota)
          { name: 'Beta-med-48cpu',     orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(48), memoryMiB: memoryMiBFromGb(192), gpu: 0, durationSeconds: 7200,  intervalSeconds: 900,  userPriority: 2, toolPriority: 3 },
          // org-gamma: 64 CPU, 3h, every 20min = 9 concurrent × 64 = 576 demand,
          // quota caps at 384 (6 running, 3 queued)
          { name: 'Gamma-med-64cpu',    orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256), gpu: 0, durationSeconds: 10800, intervalSeconds: 1200, userPriority: 3, toolPriority: 3 },
          // Background small jobs to fill gaps
          // DO: 2700/300 = 9 × 8 = 72 CPU
          { name: 'BG-deeporigin-8cpu', orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),  gpu: 0, durationSeconds: 2700,  intervalSeconds: 300,  userPriority: 2, toolPriority: 2 },
          // Beta: 600/120 = 5 × 4 = 20 CPU
          { name: 'BG-beta-4cpu',       orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(4), memoryMiB: memoryMiBFromGb(16),  gpu: 0, durationSeconds: 600,   intervalSeconds: 120,  userPriority: 1, toolPriority: 1 },
          // Gamma: 1800/300 = 6 × 8 = 48 CPU
          { name: 'BG-gamma-8cpu',      orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),  gpu: 0, durationSeconds: 1800,  intervalSeconds: 300,  userPriority: 2, toolPriority: 2 },
        ],
        // Demand: DO 512+72=584, beta 384+20=404, gamma 576+48=624
        // Quotas shared per org: beta main alone = 384 (quota full),
        // gamma main alone = 384 (6×64, quota full).
        // BG jobs for beta/gamma can only run during brief gaps.
        // Effective running: DO 584 + beta 384 + gamma 384 = ~1,352
        // (pool = 1,362). Formula decides cross-org priority.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 7007,
    },
  },

  // ── Phase 4 — Stress Tests (from Scenario Analysis Report §2.1) ─────────

  {
    id: 'queue-flood',
    name: 'S1: Queue Flood',
    description: 'org-beta floods 2,880 jobs (8 CPU, 30min) saturating its 384-CPU quota while deeporigin + org-gamma compete for remaining capacity — tests priority isolation under queue + resource pressure',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // org-beta flood: 8 CPU jobs every 30s = 2,880/day
          // 1800s/30s = 60 concurrent × 8 = 480 CPU demand,
          // quota caps at 384 (48 running, 12 always queued)
          { name: 'Flood-8cpu',         orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 0, durationSeconds: 1800,  intervalSeconds: 30,   userPriority: 1, toolPriority: 1 },
          // deeporigin critical: 128 CPU, 2h, every 1h = 24/day
          // 7200s/3600s = 2 concurrent × 128 = 256 CPU
          { name: 'Critical-128cpu',    orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(128), memoryMiB: memoryMiBFromGb(512),  gpu: 0, durationSeconds: 7200,  intervalSeconds: 3600, userPriority: 5, toolPriority: 5 },
          // deeporigin background: 32 CPU, 1h, every 5min
          // 3600s/300s = 12 concurrent × 32 = 384 CPU
          { name: 'DO-background-32cpu', orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 300,  userPriority: 3, toolPriority: 3 },
          // org-gamma normal: 32 CPU, 1h, every 4min
          // 3600s/240s = 15 concurrent × 32 = 480 demand,
          // quota caps at 384 (12 running, 3 queued)
          { name: 'Normal-32cpu',       orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 240,  userPriority: 3, toolPriority: 3 },
        ],
        // Total running: beta 384 + DO 640 + gamma 384 = 1,408 > 1,362
        // All 3 orgs hit quota walls + pool capacity contested.
        // org-gamma is the "collateral damage" indicator.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 8001,
    },
  },
  {
    id: 'whale-blockade',
    name: 'S2: Whale Blockade',
    description: '768-CPU whale arrives every 5h into ~750 CPU of background load — whale can\'t fit, must trigger reservation mode while small jobs backfill around it',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // The whale: 768 CPU (56% of mason pool), 4h, every 5h
          // Non-overlapping (dur < interval), but arrives into saturated cluster.
          // DO quota: 96 (medium) + 768 = 864 < 1,364. Quota OK.
          // Pool: 750 (bg) + 768 = 1,518 > 1,360. Gate 2 blocks.
          { name: 'WHALE-768cpu',       orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(768), memoryMiB: memoryMiBFromGb(3072), gpu: 0, durationSeconds: 14400, intervalSeconds: 18000, userPriority: 5, toolPriority: 5 },
          // deeporigin medium: 16 CPU, 1h, every 10min = 6 × 16 = 96 CPU
          { name: 'Medium-DO-16cpu',    orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 3600,  intervalSeconds: 600,  userPriority: 3, toolPriority: 3 },
          // org-beta: 16 CPU every 45s, 20min dur = 26.7 concurrent × 16
          // = 427 demand, quota caps at 384 (24 running)
          { name: 'BG-beta-16cpu',      orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 1200,  intervalSeconds: 45,   userPriority: 2, toolPriority: 2 },
          // org-gamma: 16 CPU every 50s, 15min dur = 18 concurrent × 16
          // = 288 CPU (within 384 quota)
          { name: 'BG-gamma-16cpu',     orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 900,   intervalSeconds: 50,   userPriority: 2, toolPriority: 3 },
        ],
        // Background steady-state: 96 + 384 + 288 = 768 CPU (~56% util)
        // Whale needs 768 more → 1,536 > 1,360. Must wait ~20-40 min
        // for enough bg jobs to complete during reservation mode.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 8002,
    },
  },
  {
    id: 'gpu-famine',
    name: 'S3: GPU Famine',
    description: 'GPU pool contention: 3 orgs competing for 192 GPUs with total demand far exceeding supply — tests GPU-pool scheduling in isolation',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin: large GPU training jobs (32 GPU each, every 12m) — 160 GPU/hr demand
          { name: 'ML-training-32gpu',  orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256),  gpu: 32, durationSeconds: 7200,  intervalSeconds: 720,  userPriority: 4, toolPriority: 5 },
          // org-beta: high-frequency inference (4 GPU each, every 3m) — 80 GPU/hr demand
          { name: 'Inference-4gpu',     orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 4,  durationSeconds: 900,   intervalSeconds: 180,  userPriority: 2, toolPriority: 2 },
          // org-gamma: medium docking jobs (16 GPU each, every 20m) — 48 GPU/hr demand
          { name: 'Docking-16gpu',      orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 16, durationSeconds: 14400, intervalSeconds: 1200, userPriority: 3, toolPriority: 4 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 8003,
    },
  },
  {
    id: 'sustained-pareto-stress',
    name: 'S4: Sustained Pareto Stress',
    description: 'Heavy Pareto load (α=1.5) at 18 jobs/min over 24h — near-capacity baseline where Pareto tail spikes create transient overload and queue recovery cycles',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      // 18 jobs/min with avg ~24 CPU (Pareto mean for α=1.5, xMin=8)
      // avg duration ~180s → ~54 concurrent × 24 CPU ≈ 1,296 CPU (~95% util)
      // Pareto tail produces 128-CPU outliers that tip into overload,
      // triggering reservation mode. Between spikes, queue drains via backfill.
      // Safe: queue oscillates rather than growing monotonically.
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 18 },
      sizeDistribution: { type: 'pareto', alpha: 1.5, cpuMin: 8, memoryMin: 32, gpuMin: 0, durationMin: 60 },
      seed: 8004,
    },
  },

  {
    id: 'cascading-failure',
    name: 'S5: Cascading Failure Recovery',
    description: 'MMPP simulates failure-recovery cycles: normal (1/min) → failure-burst (4/min, resubmitted jobs) → degraded (0.2/min) every 30 min over 24h — tests scheduler resilience to sudden load spikes',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'mmpp',
        states: [
          // Mixed 60/25/15: E[CPU×dur] ≈ 55,020 CPU-s/job → 917 CPU per
          // job/min. Saturation at ~1.48 jobs/min (917 × 1.48 ≈ 1,362).
          // Normal operation: 1/min × 917 = 917 CPU ≈ 67% utilisation
          { label: 'normal', lambdaPerMinute: 1, weight: 0.45 },
          // Failure-recovery burst: 4/min ≈ 270% util — massive
          // spike simulates resubmitted jobs after nodes crash.
          // Queue builds fast but drains during degraded phase.
          { label: 'failure-burst', lambdaPerMinute: 4, weight: 0.20 },
          // Degraded: 0.2/min ≈ 13% util — cluster partially
          // recovered, reduced submission rate. Queue drains.
          { label: 'degraded', lambdaPerMinute: 0.2, weight: 0.35 },
        ],
        transitionInterval: 1800,
      },
      sizeDistribution: {
        type: 'mixed', small: 60, medium: 25, large: 15,
      },
      seed: 8005,
    },
  },

  // ── Phase 5 — Realistic Production Workloads (from Scenario Analysis Report §2.2) ──

  {
    id: 'monday-morning-rush',
    name: 'R1: Monday Morning Rush',
    description: 'Diurnal MMPP: night (0.5/min) → day (1.5/min) → peak (3/min) cycling over 48h — tests scheduling under realistic day/night load patterns',
    phase: 5,
    workloadConfig: {
      durationSeconds: 172800,
      arrivalPattern: {
        type: 'mmpp',
        states: [
          // Mixed 65/25/10: E[CPU×dur] ≈ 38,280 CPU-s/job → 638 CPU per
          // job/min. Saturation at ~2.1 jobs/min (638 × 2.1 ≈ 1,340).
          // Night: 0.5/min × 638 = 319 CPU ≈ 25% util — queue drains
          { label: 'night',  lambdaPerMinute: 0.5, weight: 0.38 },
          // Day: 1.5/min ≈ 70% util — steady load, slight queuing
          { label: 'day',    lambdaPerMinute: 1.5, weight: 0.42 },
          // Peak: 3/min ≈ 140% util — queue builds but safely
          // drains during subsequent night phases
          { label: 'peak',   lambdaPerMinute: 3,   weight: 0.20 },
        ],
        transitionInterval: 3600,
      },
      sizeDistribution: { type: 'mixed', small: 65, medium: 25, large: 10 },
      seed: 9001,
    },
  },
  {
    id: 'dominant-tenant',
    name: 'R2: Dominant Tenant',
    description: 'org-beta submits ~62% of all jobs (small), deeporigin ~9% (large), org-gamma ~29% (medium) — tests fairness when one org dominates volume while another creates heavy resource contention',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // org-beta: 70% of 720 jobs/day = ~504 small jobs (every ~171s)
          { name: 'Beta-small-4cpu',    orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(4), memoryMiB: memoryMiBFromGb(16),   gpu: 0, durationSeconds: 900,   intervalSeconds: 171,  userPriority: 1, toolPriority: 2 },
          // deeporigin: 10% of 720 = ~72 large jobs (every 1200s = 20m)
          { name: 'DO-large-128cpu',    orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(128), memoryMiB: memoryMiBFromGb(512),  gpu: 0, durationSeconds: 14400, intervalSeconds: 1200, userPriority: 4, toolPriority: 5 },
          // org-gamma: ~240 medium jobs (every 360s = 6m)
          // 3600/360 = 10 × 32 = 320 CPU demand → deeper queue, formula divergence
          { name: 'Gamma-medium-32cpu', orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 360,  userPriority: 3, toolPriority: 3 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 9002,
    },
  },
  {
    id: 'mixed-multi-org',
    name: 'R3: Mixed Multi-Org Workload',
    description: 'Diverse job types across 3 orgs at ~100% cluster utilization — org-beta and org-gamma hit quota walls, tests cross-pool scheduling and fairness under real contention',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin: prep + compute + GPU (CPU pool ~350 CPU)
          // 900/300 = 3 × 8 = 24 CPU
          { name: 'DO-prep-8cpu',         orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 0, durationSeconds: 900,   intervalSeconds: 300, userPriority: 3, toolPriority: 3 },
          // 3600/360 = 10 × 32 = 320 CPU
          { name: 'DO-compute-32cpu',     orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 360, userPriority: 3, toolPriority: 4 },
          // GPU pool: 7200/720 = 10 × (16 CPU, 8 GPU)
          { name: 'DO-gpu-8gpu',          orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 8, durationSeconds: 7200,  intervalSeconds: 720, userPriority: 3, toolPriority: 5 },
          // org-beta: prep + compute (CPU pool)
          // 1800/300 = 6 × 16 = 96 CPU
          { name: 'Beta-prep-16cpu',      orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 1800,  intervalSeconds: 300, userPriority: 2, toolPriority: 3 },
          // 3600/360 = 10 × 64 = 640 demand, quota caps at 384
          // (6 running, 4 queued per cycle)
          { name: 'Beta-compute-64cpu',   orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 360, userPriority: 2, toolPriority: 4 },
          // org-gamma: analysis + compute + background
          // 1800/240 = 7.5 × 16 = 120 CPU
          { name: 'Gamma-analysis-16cpu', orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 1800,  intervalSeconds: 240, userPriority: 2, toolPriority: 2 },
          // 3600/480 = 7.5 × 32 = 240 CPU demand → gamma total 360 (within 384)
          { name: 'Gamma-compute-32cpu',  orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 480, userPriority: 2, toolPriority: 3 },
          // 1800/120 = 15 × 8 = 120 CPU → gamma total 480, quota caps at 384
          { name: 'BG-standalone-cpu',    orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 0, durationSeconds: 1800,  intervalSeconds: 120, userPriority: 1, toolPriority: 1 },
          // GPU pool: org-beta GPU jobs
          { name: 'BG-standalone-gpu',    orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 4, durationSeconds: 3600,  intervalSeconds: 720, userPriority: 2, toolPriority: 2 },
        ],
        // CPU pool demand: DO 344, beta 96+640=736, gamma 120+240+120=480
        // Quotas shared per org: beta capped at 384, gamma capped at 384
        // Effective running: DO 344 + beta 384 + gamma 384 = ~1,112
        // GPU pool: DO 80 GPU (10×8), beta 20 GPU (5×4) = 100 GPU
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 9003,
    },
  },

  {
    id: 'workflow-chains',
    name: 'R4: Workflow Chains',
    description: 'Three concurrent pipelines (prep→compute→GPU) at ~95% cluster util — org-beta hits quota wall on 64-CPU docking jobs, tests cross-pool and cross-pipeline fairness',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // ── MolProps pipeline (deeporigin) ──
          // Stage 1: Prep — every 3 min (20/hr)
          // 900/180 = 5 × 8 = 40 CPU
          { name: 'MolProps-prep-8cpu',    orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 0, durationSeconds: 900,   intervalSeconds: 180,  userPriority: 3, toolPriority: 3 },
          // Stage 2: Compute — every 4 min (15/hr)
          // 3600/240 = 15 × 32 = 480 CPU
          { name: 'MolProps-main-32cpu',   orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 240,  userPriority: 3, toolPriority: 4 },
          // Stage 3: GPU finish — every 12 min (5/hr)
          // 7200/720 = 10 × (16 CPU, 8 GPU) = 160 CPU, 80 GPU
          { name: 'MolProps-gpu-8gpu',     orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 8, durationSeconds: 7200,  intervalSeconds: 720,  userPriority: 3, toolPriority: 5 },

          // ── Docking pipeline (org-beta) ──
          // Stage 1: Prep — every 3 min
          // 1200/180 = 6.7 × 16 = 107 CPU
          { name: 'Docking-prep-16cpu',    orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 1200,  intervalSeconds: 180,  userPriority: 2, toolPriority: 3 },
          // Stage 2: Main — every 8 min
          // 3600/480 = 7.5 × 64 = 480 demand, quota caps at 384
          { name: 'Docking-main-64cpu',    orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 480,  userPriority: 2, toolPriority: 4 },

          // ── Analysis pipeline (org-gamma) ──
          // Stage 1: Prep — every 3 min
          // 600/180 = 3.3 × 8 = 27 CPU
          { name: 'Analysis-prep-8cpu',    orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 0, durationSeconds: 600,   intervalSeconds: 180,  userPriority: 2, toolPriority: 2 },
          // Stage 2: Main — every 4 min
          // 1800/240 = 7.5 × 32 = 240 CPU
          { name: 'Analysis-main-32cpu',   orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 1800,  intervalSeconds: 240,  userPriority: 2, toolPriority: 3 },

          // Background standalone jobs (org-gamma)
          // 1800/90 = 20 × 8 = 160 CPU → gamma total ~427, exceeds 384 quota
          { name: 'BG-standalone-cpu',     orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(8), memoryMiB: memoryMiBFromGb(32),   gpu: 0, durationSeconds: 1800,  intervalSeconds: 90,   userPriority: 1, toolPriority: 1 },
        ],
        // CPU pool: DO 520 + beta 384 (quota-capped; 587 demand)
        // + gamma 384 (quota-capped; 427 demand) = ~1,288 (94.6%).
        // Both beta and gamma exceed quotas → real queueing.
        // GPU pool: DO 160 CPU, 80 GPU → moderate GPU pressure.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 9004,
    },
  },
  {
    id: 'priority-size-inversion',
    name: 'R5: Priority-Size Inversion',
    description:
      'org-gamma (lowest priority) submits 128-CPU '
      + 'jobs every 8 min while deeporigin (highest '
      + 'priority) floods small 4-CPU jobs every 8 s '
      + '— tests whether formulas let high-priority '
      + 'small jobs flow or large low-priority jobs '
      + 'starve them via reservation mode',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin (prio 3, quota 1364 CPU):
          // many small 4-CPU jobs, 15 min each,
          // every 8s.
          // Concurrent: 900/8 ≈ 113 × 4 = 450 CPU
          {
            name: 'DO-small-4cpu',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(4), memoryMiB: memoryMiBFromGb(16),
            gpu: 0,
            durationSeconds: 900,
            intervalSeconds: 8,
            userPriority: 4,
            toolPriority: 4,
          },
          // org-gamma (prio 1, quota 384 CPU):
          // few large 128-CPU jobs, 4h each,
          // every 8 min. Arrival rate ≈ 30
          // concurrent, but only 3 fit within
          // 384-CPU quota → queue of ~27 pending.
          {
            name: 'Gamma-large-128cpu',
            orgId: 'org-gamma',
            cpuMillis: cpuMillisFromVcpu(128), memoryMiB: memoryMiBFromGb(512),
            gpu: 0,
            durationSeconds: 14400,
            intervalSeconds: 480,
            userPriority: 1,
            toolPriority: 1,
          },
          // org-beta (prio 2, quota 384 CPU):
          // steady medium baseline, 16 CPU,
          // 1h each, every 90s.
          // Concurrent: min(40, 24) = 24 × 16
          // = 384 CPU (quota-limited).
          {
            name: 'Beta-medium-16cpu',
            orgId: 'org-beta',
            cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),
            gpu: 0,
            durationSeconds: 3600,
            intervalSeconds: 90,
            userPriority: 2,
            toolPriority: 3,
          },
        ],
        // CPU demand: DO 450 + gamma 384 + beta
        // 384 = 1,218 / 1,362 ≈ 89% utilisation.
        // Gamma queue builds to ~27 pending
        // 128-CPU jobs. The key question: do
        // formulas let DO's 4-CPU jobs flow, or
        // does gamma's reservation mode block
        // everything?
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0,
        gpu: 0,
        duration: 0,
      },
      seed: 10003,
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  // R6: Multi-Pool Heavy Hybrid (All Hybrid, 24h)
  //
  // 100% multi-pool workload over a 24-hour arrival window, modelled after
  // full-24h-simulation but every template is hybrid (§1.4 — holds capacity
  // in BOTH mason and mason-gpu concurrently). Every admission is an AND
  // across two Gate-1 checks (org quota per pool) and two Gate-2 checks
  // (pool capacity). Offered load is deliberately configured so two
  // different per-org Gate-1s persistently queue:
  //   - Beta runs 131% of its 25% GPU quota → Gate 1 queues on mason-gpu.
  //   - Gamma runs 126% of its 28% mason quota → Gate 1 queues on mason.
  //   - DO stays comfortable (42% of its 100% GPU quota).
  // Arrivals stop at t=24h; Beta's GPU backlog and Gamma's mason backlog
  // drain at their quota caps afterwards. TTL is Infinity so no evictions
  // distort the picture — the scenario isolates admission + aging +
  // reservation-mode behaviour under sustained multi-quota contention.
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'multi-pool-overload-pipelines',
    name: 'R6: Multi-Pool Heavy Hybrid (All Hybrid, 24h)',
    description:
      '24-hour 100%-hybrid overload (§1.4), modelled after full-24h-simulation '
      + 'but with every template multi-pool. DO is comfortable (~42% of its '
      + 'GPU quota). Beta runs ~31% over its 25% GPU quota, so Beta-hybrid-* '
      + 'jobs persistently queue at Gate 1 on mason-gpu. Gamma runs ~26% over '
      + 'its 28% mason quota, so Gamma-hybrid-* jobs persistently queue at '
      + 'Gate 1 on mason. Every admission is an AND across two Gate-1 checks '
      + '(one per pool) and two Gate-2 checks (pool capacity). Arrivals stop '
      + 'at t=24h; Beta and Gamma backlogs drain at their quota caps '
      + 'afterwards. TTL is Infinity — zero evictions — so the scenario '
      + 'isolates admission + aging + reservation-mode behaviour under '
      + 'sustained quota contention.',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400, // 24h arrival window
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // ── deeporigin (priority 3, 100%/100% quotas) ────────────────────
          // DO MolDynamics + GPU refinement — CPU-leaning hybrid.
          // 900s / 90s = 10 concurrent × (32 mason + 16 gpu-vCPU + 4 GPU)
          // → 320 mason vCPU, 160 gpu vCPU, 40 GPU.
          {
            name: 'DO-hybrid-md',
            orgId: 'deeporigin',
            cpuMillis: 0, memoryMiB: 0, gpu: 0,
            resourcesByType: {
              'mason': {
                cpuMillis: cpuMillisFromVcpu(32),
                memoryMiB: memoryMiBFromGb(128),
                gpu: 0,
              },
              'mason-gpu': {
                cpuMillis: cpuMillisFromVcpu(16),
                memoryMiB: memoryMiBFromGb(64),
                gpu: 4,
              },
            },
            durationSeconds: 900,
            intervalSeconds: 90,
            userPriority: 3,
            toolPriority: 4,
          },
          // DO small CPU-prep + GPU-inference pipeline — GPU-leaning hybrid.
          // 800s / 120s = 6.67 concurrent × (8 mason + 16 gpu-vCPU + 6 GPU)
          // → 53.3 mason vCPU, 106.7 gpu vCPU, 40 GPU.
          {
            name: 'DO-hybrid-pipeline',
            orgId: 'deeporigin',
            cpuMillis: 0, memoryMiB: 0, gpu: 0,
            resourcesByType: {
              'mason': {
                cpuMillis: cpuMillisFromVcpu(8),
                memoryMiB: memoryMiBFromGb(32),
                gpu: 0,
              },
              'mason-gpu': {
                cpuMillis: cpuMillisFromVcpu(16),
                memoryMiB: memoryMiBFromGb(64),
                gpu: 6,
              },
            },
            durationSeconds: 800,
            intervalSeconds: 120,
            userPriority: 3,
            toolPriority: 3,
          },

          // ── org-beta (priority 2, 28%/25% quotas) ────────────────────────
          // Beta inference — GPU-heavy hybrid. Offered GPU alone matches Beta's
          // entire 48-GPU quota, so eval is pure overshoot on Gate 1.
          // 600s / 100s = 6 concurrent × (8 mason + 8 gpu-vCPU + 8 GPU)
          // → 48 mason vCPU, 48 gpu vCPU, 48 GPU (= Beta's full GPU quota).
          {
            name: 'Beta-hybrid-infer',
            orgId: 'org-beta',
            cpuMillis: 0, memoryMiB: 0, gpu: 0,
            resourcesByType: {
              'mason': {
                cpuMillis: cpuMillisFromVcpu(8),
                memoryMiB: memoryMiBFromGb(32),
                gpu: 0,
              },
              'mason-gpu': {
                cpuMillis: cpuMillisFromVcpu(8),
                memoryMiB: memoryMiBFromGb(32),
                gpu: 8,
              },
            },
            durationSeconds: 600,
            intervalSeconds: 100,
            userPriority: 3,
            toolPriority: 4,
          },
          // Beta eval — balanced hybrid. Drives Beta 31% over GPU quota.
          // 750s / 150s = 5 concurrent × (12 mason + 8 gpu-vCPU + 3 GPU)
          // → 60 mason vCPU, 40 gpu vCPU, 15 GPU.
          {
            name: 'Beta-hybrid-eval',
            orgId: 'org-beta',
            cpuMillis: 0, memoryMiB: 0, gpu: 0,
            resourcesByType: {
              'mason': {
                cpuMillis: cpuMillisFromVcpu(12),
                memoryMiB: memoryMiBFromGb(48),
                gpu: 0,
              },
              'mason-gpu': {
                cpuMillis: cpuMillisFromVcpu(8),
                memoryMiB: memoryMiBFromGb(32),
                gpu: 3,
              },
            },
            durationSeconds: 750,
            intervalSeconds: 150,
            userPriority: 2,
            toolPriority: 3,
          },

          // ── org-gamma (priority 1, 28%/25% quotas) ───────────────────────
          // Gamma training — mason-heavy hybrid. Gamma has only a 382-vCPU
          // mason quota, so this template alone uses 56% of that.
          // 1200s / 90s = 13.33 concurrent × (16 mason + 8 gpu-vCPU + 2 GPU)
          // → 213 mason vCPU, 107 gpu vCPU, 26.7 GPU.
          {
            name: 'Gamma-hybrid-train',
            orgId: 'org-gamma',
            cpuMillis: 0, memoryMiB: 0, gpu: 0,
            resourcesByType: {
              'mason': {
                cpuMillis: cpuMillisFromVcpu(16),
                memoryMiB: memoryMiBFromGb(64),
                gpu: 0,
              },
              'mason-gpu': {
                cpuMillis: cpuMillisFromVcpu(8),
                memoryMiB: memoryMiBFromGb(32),
                gpu: 2,
              },
            },
            durationSeconds: 1200,
            intervalSeconds: 90,
            userPriority: 2,
            toolPriority: 3,
          },
          // Gamma analysis — CPU-heavy hybrid. Drives Gamma 26% over its
          // mason quota when combined with train.
          // 1000s / 90s = 11.11 concurrent × (24 mason + 4 gpu-vCPU + 1 GPU)
          // → 267 mason vCPU, 44.4 gpu vCPU, 11.1 GPU.
          {
            name: 'Gamma-hybrid-analysis',
            orgId: 'org-gamma',
            cpuMillis: 0, memoryMiB: 0, gpu: 0,
            resourcesByType: {
              'mason': {
                cpuMillis: cpuMillisFromVcpu(24),
                memoryMiB: memoryMiBFromGb(96),
                gpu: 0,
              },
              'mason-gpu': {
                cpuMillis: cpuMillisFromVcpu(4),
                memoryMiB: memoryMiBFromGb(16),
                gpu: 1,
              },
            },
            durationSeconds: 1000,
            intervalSeconds: 90,
            userPriority: 1,
            toolPriority: 2,
          },
        ],
        // Pool demand (steady-state, 100% hybrid, full-24h-simulation pattern):
        //   mason:     320 + 53 + 48 + 60 + 213 + 267 =   961 vCPU (70% of 1,364)
        //   mason-gpu: 160 + 107 + 48 + 40 + 107 + 44 =   506 vCPU (66% of   768)
        //   GPU:        40 +  40 + 48 + 15 +  27 + 11 =   181 GPU  (94% of   192)
        // Per-org GPU demand vs 25% quota (48 GPU for Beta & Gamma):
        //   DO    =  80 GPU (100% quota = 192 — comfortable at 42%)
        //   Beta  =  63 GPU (131% of 48 — Gate 1 persistently queues on mason-gpu)
        //   Gamma =  38 GPU ( ≤ 48 — Gamma pool-gated, not GPU-quota-gated)
        // Per-org mason vCPU demand vs 28% quota (382 for Beta & Gamma):
        //   DO    = 373 vCPU (100% quota = 1,364 — comfortable at 27%)
        //   Beta  = 108 vCPU ( ≤ 382 — OK)
        //   Gamma = 480 vCPU (126% of 382 — Gate 1 persistently queues on mason)
        // Per-org mason-gpu vCPU demand vs 25% quota (192 for Beta & Gamma):
        //   DO    = 267 vCPU (100% quota = 768 — OK)
        //   Beta  =  88 vCPU ( ≤ 192 — OK)
        //   Gamma = 151 vCPU ( ≤ 192 — OK)
        // Effective running (admission-capped at Gate 1):
        //   DO     80 GPU / 373 mason (unchanged — under quotas)
        //   Beta   48 GPU / 108 mason (GPU quota caps at 48; excess 15 GPU queues)
        //   Gamma  38 GPU / 382 mason (mason quota caps at 382; excess 98 vCPU queues)
        //   Running GPU: 80+48+38 = 166 of 192 (86% util, headroom for bursts)
        //   Running mason: 373+108+382 = 863 of 1,364 (63% util)
        // Arrivals over 24h window:
        //   DO-hybrid-md         86400/90 =   960
        //   DO-hybrid-pipeline   86400/120 =   720
        //   Beta-hybrid-infer    86400/100 =   864
        //   Beta-hybrid-eval     86400/150 =   576
        //   Gamma-hybrid-train   86400/90  =   960
        //   Gamma-hybrid-analys  86400/90  =   960
        //   Total                          = 5,040 jobs, 100% multi-pool
        // After arrivals stop at t=24h, Beta GPU backlog and Gamma mason
        // backlog drain at their quota caps. Expected total drain: ~28-32h.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10007,
    },
  },

  // ── Phase 6 — Adversarial & Game-Theory (from Scenario Analysis Report §2.3) ────

  {
    id: 'job-splitting-attack',
    name: 'A1: Job Splitting Attack',
    description:
      'Background load fills ~47% of cluster, then deeporigin '
      + 'submits 128-CPU jobs every 20 min while org-beta '
      + 'submits 4-CPU jobs every 38 s (~760 CPU-hrs/hr each)'
      + ' — tests whether splitting games the formula',
    phase: 6,
    workloadConfig: {
      durationSeconds: 43200,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // Background: deeporigin steady load fills ~640 CPU
          // 3600s / 180s = 20 concurrent × 32 CPU = 640 CPU
          {
            name: 'DO-background',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),
            gpu: 0,
            durationSeconds: 3600,
            intervalSeconds: 180,
            userPriority: 3,
            toolPriority: 3,
          },
          // deeporigin honest: 128 CPU, 2h, every 20 min
          // 7200s / 1200s = 6 concurrent × 128 = 768 CPU
          // DO total: 640 + 768 = 1,408 > 1,364 quota → queuing
          {
            name: 'Honest-128cpu',
            orgId: 'deeporigin',
            cpuMillis: cpuMillisFromVcpu(128), memoryMiB: memoryMiBFromGb(512),
            gpu: 0,
            durationSeconds: 7200,
            intervalSeconds: 1200,
            userPriority: 3,
            toolPriority: 3,
          },
          // org-beta splitter: 4 CPU, 2h, every 38 s
          // 7200s / 38s ≈ 189 concurrent × 4 = 756 CPU, but
          // quota caps at 384 CPU (96 concurrent)
          // ~760 CPU-hrs/hr ≈ deeporigin's ~768 CPU-hrs/hr
          {
            name: 'Split-4cpu',
            orgId: 'org-beta',
            cpuMillis: cpuMillisFromVcpu(4), memoryMiB: memoryMiBFromGb(16),
            gpu: 0,
            durationSeconds: 7200,
            intervalSeconds: 38,
            userPriority: 3,
            toolPriority: 3,
          },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0,
      },
      seed: 10001,
    },
  },
  {
    id: 'priority-inversion-stress',
    name: 'A2: Priority Inversion Stress',
    description: 'Two low-priority orgs saturate cluster to ~86%, deeporigin\'s own background fills more — critical 256-CPU job can\'t fit without reservation mode draining resources',
    phase: 6,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // org-gamma: 16 CPU jobs, 3h duration, every 2 min
          // 10800s / 120s = 90 arrivals per 3h window, but quota caps at
          // 24 concurrent (24 × 16 = 384 CPU = quota limit)
          { name: 'Gamma-fill-16cpu',   orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 10800, intervalSeconds: 120,  userPriority: 2, toolPriority: 2 },
          // org-beta: 32 CPU jobs, 2h duration, every 2 min
          // 7200s / 120s = 60 arrivals per 2h window, quota caps at
          // 12 concurrent (12 × 32 = 384 CPU = quota limit)
          { name: 'Beta-fill-32cpu',    orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 7200,  intervalSeconds: 120,  userPriority: 2, toolPriority: 2 },
          // deeporigin background: 32 CPU jobs, 1h, every 3 min
          // 3600s / 180s = 20 concurrent × 32 = 640 CPU demand,
          // but cluster headroom after gamma+beta = ~594 CPU,
          // so ~18 concurrent fit (576 CPU). Total occupied: ~1,344 CPU.
          // Only ~18 CPU free — the 256-CPU critical job CANNOT fit.
          { name: 'DO-background-32cpu', orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(32), memoryMiB: memoryMiBFromGb(128),  gpu: 0, durationSeconds: 3600,  intervalSeconds: 180,  userPriority: 3, toolPriority: 3 },
          // deeporigin critical: 5 large jobs (256 CPU, 1h, every ~4.8h)
          // Must trigger reservation mode to accumulate 256 free CPU
          // by blocking new dispatches until enough jobs complete.
          { name: 'DO-critical-256cpu', orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(256), memoryMiB: memoryMiBFromGb(1024), gpu: 0, durationSeconds: 3600,  intervalSeconds: 17280, userPriority: 5, toolPriority: 5 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10002,
    },
  },
  {
    id: 'starvation-gauntlet',
    name: 'A3: Starvation Gauntlet',
    description: 'Worst-case aging: deeporigin + org-beta saturate cluster continuously, org-gamma submits a single 16-CPU job — tests whether aging guarantees eventual execution',
    phase: 6,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin: continuous 128-CPU stream every 10m (max priority)
          { name: 'Alpha-stream-128cpu', orgId: 'deeporigin', cpuMillis: cpuMillisFromVcpu(128), memoryMiB: memoryMiBFromGb(512),  gpu: 0, durationSeconds: 7200,  intervalSeconds: 600,  userPriority: 5, toolPriority: 5 },
          // org-beta: continuous 64-CPU stream every 10m (high priority)
          { name: 'Beta-stream-64cpu',   orgId: 'org-beta',   cpuMillis: cpuMillisFromVcpu(64), memoryMiB: memoryMiBFromGb(256),  gpu: 0, durationSeconds: 7200,  intervalSeconds: 600,  userPriority: 4, toolPriority: 4 },
          // org-gamma: SINGLE 16-CPU job (submitted once at start, lowest priority)
          { name: 'Gamma-single-16cpu',  orgId: 'org-gamma',  cpuMillis: cpuMillisFromVcpu(16), memoryMiB: memoryMiBFromGb(64),   gpu: 0, durationSeconds: 1800,  intervalSeconds: 86400, userPriority: 1, toolPriority: 1 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10004,
    },
  },
  {
    id: 'oscillating-demand',
    name: 'A4: Oscillating Demand',
    description: 'Rapid MMPP: micro-bursts (7/min) → silence → heavy batch (0.2/min) cycling every 15min — tests formula stability under rapid load swings',
    phase: 6,
    workloadConfig: {
      durationSeconds: 43200,
      arrivalPattern: {
        type: 'mmpp',
        states: [
          { label: 'micro-burst', lambdaPerMinute: 7,    weight: 0.35 },
          { label: 'heavy-batch', lambdaPerMinute: 0.2,  weight: 0.30 },
          { label: 'silence',     lambdaPerMinute: 0.02, weight: 0.35 },
        ],
        transitionInterval: 900,
      },
      sizeDistribution: { type: 'uniform', cpuRange: [2, 256], memoryRange: [8, 1024], gpuRange: [0, 0], durationRange: [300, 7200] },
      seed: 10005,
    },
  },
];
