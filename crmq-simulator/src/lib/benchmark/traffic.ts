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

import type { Resources, Org, CRMQConfig } from '../types';

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
  cpu: number;
  memory: number;
  gpu: number;
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
        resources: { cpu: dist.cpu, memory: dist.memory, gpu: dist.gpu },
        duration: dist.duration,
      };

    case 'uniform':
      return {
        resources: {
          cpu: rng.nextInt(dist.cpuRange[0], dist.cpuRange[1]),
          memory: rng.nextInt(dist.memoryRange[0], dist.memoryRange[1]),
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
          cpu: Math.min(cpu, 128),       // cap to prevent extreme outliers
          memory: Math.min(memory, 512),
          gpu: Math.min(gpu, 16),
        },
        duration: Math.min(duration, 28800), // cap at 8 hours
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
          cpu: rng.nextInt(cls.cpuRange[0], cls.cpuRange[1]),
          memory: rng.nextInt(cls.memRange[0], cls.memRange[1]),
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
        jobs.push({
          name: `${tpl.name} #${++idx}`,
          orgId: tpl.orgId,
          userPriority: tpl.userPriority,
          toolPriority: tpl.toolPriority,
          resources: { cpu: tpl.cpu, memory: tpl.memory, gpu: tpl.gpu },
          estimatedDuration: duration,
          ttl: Infinity,
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
    const ttl = Infinity;

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
}

/**
 * Workload sizing notes:
 *   Default cluster: mason = 1362 usable CPU, mason-gpu = 767 usable CPU / 192 GPU
 *   To hit ~80% CPU utilization with avg 16 CPU jobs at 120s avg duration:
 *     concurrent_slots = 0.8 × 1362 / 16 ≈ 68 concurrent jobs
 *     arrival_rate = 68 / (120/60) = 34 jobs/min
 *   Scenarios are calibrated to create real contention and queuing.
 */

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  // Phase 1 — MVP
  {
    id: 'steady-state',
    name: 'Steady State',
    description: 'Sustained 30 jobs/min, 16-48 CPU each, 2-min avg — targets ~80% CPU utilization',
    phase: 1,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 30 },
      sizeDistribution: { type: 'uniform', cpuRange: [16, 48], memoryRange: [64, 192], gpuRange: [0, 0], durationRange: [90, 180] },
      seed: 42,
    },
  },
  {
    id: 'burst-traffic',
    name: 'Burst Traffic',
    description: '200 large jobs arrive at once — saturates cluster, tests queue drain',
    phase: 1,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'burst', count: 200, atTime: 0 },
      sizeDistribution: { type: 'uniform', cpuRange: [16, 64], memoryRange: [64, 256], gpuRange: [0, 0], durationRange: [120, 300] },
      seed: 123,
    },
  },
  {
    id: 'mixed-workload',
    name: 'Mixed Workload',
    description: '80% small, 15% medium, 5% large — 25 jobs/min, tests backfill effectiveness',
    phase: 1,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 25 },
      sizeDistribution: { type: 'mixed', small: 80, medium: 15, large: 5 },
      seed: 456,
    },
  },
  {
    id: 'priority-inversion',
    name: 'Priority Inversion',
    description: '150 jobs burst — tests whether aging rescues low-priority starved jobs',
    phase: 1,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'burst', count: 150, atTime: 0 },
      sizeDistribution: { type: 'uniform', cpuRange: [8, 32], memoryRange: [32, 128], gpuRange: [0, 0], durationRange: [120, 300] },
      seed: 789,
    },
  },

  // Phase 2 — Advanced
  {
    id: 'multi-tenant-competition',
    name: 'Multi-Tenant Competition',
    description: '30 jobs/min across 3 orgs — tests org-level fairness under heavy load',
    phase: 2,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 30 },
      sizeDistribution: { type: 'mixed', small: 70, medium: 20, large: 10 },
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
    id: 'ramp-up-down',
    name: 'Ramp-Up / Ramp-Down',
    description: 'MMPP: quiet (5/min) → busy (30/min) → peak (60/min) cycling',
    phase: 2,
    workloadConfig: {
      durationSeconds: 3600,
      arrivalPattern: {
        type: 'mmpp',
        states: [
          { label: 'quiet', lambdaPerMinute: 5, weight: 0.3 },
          { label: 'busy', lambdaPerMinute: 30, weight: 0.5 },
          { label: 'peak', lambdaPerMinute: 60, weight: 0.2 },
        ],
        transitionInterval: 600,
      },
      sizeDistribution: { type: 'uniform', cpuRange: [8, 32], memoryRange: [32, 128], gpuRange: [0, 0], durationRange: [60, 180] },
      seed: 4004,
    },
  },

  // Phase 3 — Edge Cases
  {
    id: 'heavy-tailed',
    name: 'Heavy-Tailed (Pareto)',
    description: 'Pareto sizes (alpha=1.5) at 15 jobs/min — extreme variance, long transients',
    phase: 3,
    workloadConfig: {
      durationSeconds: 3600,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 15 },
      sizeDistribution: { type: 'pareto', alpha: 1.5, cpuMin: 8, memoryMin: 32, gpuMin: 0, durationMin: 60 },
      seed: 5005,
    },
  },
  {
    id: 'zero-headroom',
    name: 'Zero Headroom',
    description: '300 massive jobs burst — overwhelms cluster, tests TTL eviction under pressure',
    phase: 3,
    workloadConfig: {
      durationSeconds: 1800,
      arrivalPattern: { type: 'burst', count: 300, atTime: 0 },
      sizeDistribution: { type: 'uniform', cpuRange: [32, 128], memoryRange: [128, 512], gpuRange: [0, 4], durationRange: [600, 1800] },
      seed: 6006,
    },
  },

  // Phase 3 — Full 24h Simulation (from CRMQ Full Simulation Report)
  {
    id: 'full-24h-simulation',
    name: '24h Full Simulation',
    description: '24h deterministic mix: 6 job types across 3 orgs (~1695 jobs) — production-grade benchmark',
    phase: 3,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // Primary workloads (every 5 min)
          // NOTE: orgIds must match the orgs from DEFAULT_ORGS (deeporigin, org-beta, org-gamma)
          // so that org quotas, priority lookups, and orgUsage tracking work correctly.
          { name: 'TypeA-192cpu-6hr',  orgId: 'deeporigin', cpu: 192, memory: 768, gpu: 0, durationSeconds: 21600, intervalSeconds: 300, userPriority: 3, toolPriority: 2 },
          { name: 'TypeB-4cpu-20min',  orgId: 'org-beta',   cpu: 4,   memory: 16,  gpu: 0, durationSeconds: 1200,  intervalSeconds: 300, userPriority: 2, toolPriority: 3 },
          { name: 'TypeC-16cpu-1hr',   orgId: 'org-gamma',  cpu: 16,  memory: 64,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 300, userPriority: 3, toolPriority: 4 },
          // Background workloads (varying intervals)
          { name: 'BG-deeporigin-8cpu', orgId: 'deeporigin', cpu: 8,   memory: 32,  gpu: 0, durationSeconds: 2700,  intervalSeconds: 600, userPriority: 2, toolPriority: 2 },
          { name: 'BG-beta-2cpu',       orgId: 'org-beta',   cpu: 2,   memory: 8,   gpu: 0, durationSeconds: 600,   intervalSeconds: 180, userPriority: 1, toolPriority: 1 },
          { name: 'BG-gamma-4cpu',      orgId: 'org-gamma',  cpu: 4,   memory: 16,  gpu: 0, durationSeconds: 1800,  intervalSeconds: 420, userPriority: 2, toolPriority: 3 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 }, // unused for periodic_mix
      seed: 7007,
    },
  },

  // ── Phase 4 — Stress Tests (from Scenario Analysis Report §2.1) ─────────

  {
    id: 'queue-flood',
    name: 'S1: Queue Flood',
    description: 'Low-priority job avalanche: org-beta floods ~2,000 tiny jobs while deeporigin submits 20 critical large jobs — tests priority isolation under queue pressure',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // org-beta flood: 2,009 tiny jobs (2 CPU, 5m each) over 24h
          { name: 'Flood-tiny-2cpu',    orgId: 'org-beta',   cpu: 2,   memory: 8,    gpu: 0, durationSeconds: 300,   intervalSeconds: 43,   userPriority: 1, toolPriority: 1 },
          // deeporigin critical: 20 large jobs (128 CPU, 2h each) every 72m
          { name: 'Critical-128cpu',    orgId: 'deeporigin', cpu: 128, memory: 512,  gpu: 0, durationSeconds: 7200,  intervalSeconds: 4320, userPriority: 5, toolPriority: 5 },
          // org-gamma normal: 240 medium jobs (16 CPU, 1h each) every 6m
          { name: 'Normal-16cpu',       orgId: 'org-gamma',  cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 3600,  intervalSeconds: 360,  userPriority: 3, toolPriority: 3 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 8001,
    },
  },
  {
    id: 'whale-blockade',
    name: 'S2: Whale Blockade',
    description: 'Single 768-CPU whale job (56% of cluster) blocks capacity — tests reservation mode activation and backfill effectiveness around a massive job',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // The whale: 1 massive job (768 CPU = 56% of mason pool, 8h)
          { name: 'WHALE-768cpu',       orgId: 'deeporigin', cpu: 768, memory: 3072, gpu: 0, durationSeconds: 28800, intervalSeconds: 86400, userPriority: 5, toolPriority: 5 },
          // Background small jobs from org-beta (every 4m)
          { name: 'BG-beta-8cpu',       orgId: 'org-beta',   cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 1200,  intervalSeconds: 240,  userPriority: 2, toolPriority: 2 },
          // Background small jobs from org-gamma (every 4m)
          { name: 'BG-gamma-12cpu',     orgId: 'org-gamma',  cpu: 12,  memory: 48,   gpu: 0, durationSeconds: 900,   intervalSeconds: 240,  userPriority: 2, toolPriority: 3 },
          // A few medium deeporigin jobs to keep org-load pressure
          { name: 'Medium-DO-32cpu',    orgId: 'deeporigin', cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 1800, userPriority: 3, toolPriority: 3 },
        ],
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
          { name: 'ML-training-32gpu',  orgId: 'deeporigin', cpu: 64,  memory: 256,  gpu: 32, durationSeconds: 7200,  intervalSeconds: 720,  userPriority: 4, toolPriority: 5 },
          // org-beta: high-frequency inference (4 GPU each, every 3m) — 80 GPU/hr demand
          { name: 'Inference-4gpu',     orgId: 'org-beta',   cpu: 8,   memory: 32,   gpu: 4,  durationSeconds: 900,   intervalSeconds: 180,  userPriority: 2, toolPriority: 2 },
          // org-gamma: medium docking jobs (16 GPU each, every 20m) — 48 GPU/hr demand
          { name: 'Docking-16gpu',      orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 16, durationSeconds: 14400, intervalSeconds: 1200, userPriority: 3, toolPriority: 4 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 8003,
    },
  },
  {
    id: 'cascading-failure',
    name: 'S4: Cascading Failure Recovery',
    description: 'Sustained Pareto load at 25 jobs/hr — tests queue recovery dynamics under heavy-tailed job sizes (note: actual mid-sim failure events require engine extension)',
    phase: 4,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 0.42 },
      sizeDistribution: { type: 'pareto', alpha: 1.5, cpuMin: 8, memoryMin: 32, gpuMin: 0, durationMin: 60 },
      seed: 8004,
    },
  },

  // ── Phase 5 — Realistic Production Workloads (from Scenario Analysis Report §2.2) ──

  {
    id: 'monday-morning-rush',
    name: 'R1: Monday Morning Rush',
    description: 'Diurnal MMPP: night (5/hr) → day (35/hr) → peak (70/hr) cycling over 48h — tests scheduling under realistic day/night load patterns',
    phase: 5,
    workloadConfig: {
      durationSeconds: 172800,
      arrivalPattern: {
        type: 'mmpp',
        states: [
          { label: 'night',  lambdaPerMinute: 0.083, weight: 0.38 },
          { label: 'day',    lambdaPerMinute: 0.583, weight: 0.42 },
          { label: 'peak',   lambdaPerMinute: 1.167, weight: 0.20 },
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
    description: 'org-beta submits 70% of all jobs (small), deeporigin 10% (large), org-gamma 20% (medium) — tests fairness when one org dominates submission volume',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // org-beta: 70% of 720 jobs/day = ~504 small jobs (every ~171s)
          { name: 'Beta-small-4cpu',    orgId: 'org-beta',   cpu: 4,   memory: 16,   gpu: 0, durationSeconds: 900,   intervalSeconds: 171,  userPriority: 1, toolPriority: 2 },
          // deeporigin: 10% of 720 = ~72 large jobs (every 1200s = 20m)
          { name: 'DO-large-128cpu',    orgId: 'deeporigin', cpu: 128, memory: 512,  gpu: 0, durationSeconds: 14400, intervalSeconds: 1200, userPriority: 4, toolPriority: 5 },
          // org-gamma: 20% of 720 = ~144 medium jobs (every 600s = 10m)
          { name: 'Gamma-medium-32cpu', orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 600,  userPriority: 3, toolPriority: 3 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 9002,
    },
  },
  {
    id: 'workflow-chains',
    name: 'R3: Workflow Chains',
    description: 'Multi-step pipelines (MolProps, Docking, Analysis) at 5 workflows/hr — models sequential job patterns (note: true step dependencies require engine extension)',
    phase: 5,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // MolProps pipeline (3 steps, deeporigin) — 5/hr each = every 720s
          { name: 'MolProps-prep-8cpu',   orgId: 'deeporigin', cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 900,   intervalSeconds: 720, userPriority: 3, toolPriority: 3 },
          { name: 'MolProps-main-32cpu',  orgId: 'deeporigin', cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 720, userPriority: 3, toolPriority: 4 },
          { name: 'MolProps-gpu-8gpu',    orgId: 'deeporigin', cpu: 16,  memory: 64,   gpu: 8, durationSeconds: 7200,  intervalSeconds: 720, userPriority: 3, toolPriority: 5 },
          // Docking pipeline (2 main steps, org-beta)
          { name: 'Docking-prep-16cpu',   orgId: 'org-beta',   cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 720, userPriority: 2, toolPriority: 3 },
          { name: 'Docking-main-64cpu',   orgId: 'org-beta',   cpu: 64,  memory: 256,  gpu: 0, durationSeconds: 14400, intervalSeconds: 720, userPriority: 2, toolPriority: 4 },
          // Analysis pipeline (org-gamma)
          { name: 'Analysis-16cpu',       orgId: 'org-gamma',  cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 720, userPriority: 2, toolPriority: 2 },
          // Background standalone jobs
          { name: 'BG-standalone-cpu',    orgId: 'org-gamma',  cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 180, userPriority: 1, toolPriority: 1 },
          { name: 'BG-standalone-gpu',    orgId: 'org-beta',   cpu: 16,  memory: 64,   gpu: 4, durationSeconds: 3600,  intervalSeconds: 720, userPriority: 2, toolPriority: 2 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 9003,
    },
  },

  // ── Phase 6 — Adversarial & Game-Theory (from Scenario Analysis Report §2.3) ────

  {
    id: 'job-splitting-attack',
    name: 'A1: Job Splitting Attack',
    description: 'Equal CPU-hrs: deeporigin submits 10 × 128-CPU jobs, org-beta splits into 320 × 4-CPU jobs (both 5,120 CPU-hrs) — tests whether splitting games the formula',
    phase: 6,
    workloadConfig: {
      durationSeconds: 43200,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin honest: 10 large jobs (128 CPU, 4h each) every 72m
          { name: 'Honest-128cpu',      orgId: 'deeporigin', cpu: 128, memory: 512,  gpu: 0, durationSeconds: 14400, intervalSeconds: 4320, userPriority: 3, toolPriority: 3 },
          // org-beta split: 320 small jobs (4 CPU, 4h each) every ~135s
          { name: 'Split-4cpu',         orgId: 'org-beta',   cpu: 4,   memory: 16,   gpu: 0, durationSeconds: 14400, intervalSeconds: 135,  userPriority: 3, toolPriority: 3 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10001,
    },
  },
  {
    id: 'priority-inversion-stress',
    name: 'A2: Priority Inversion Stress',
    description: 'org-gamma fills cluster to 90%, then deeporigin submits 5 critical 256-CPU jobs while org-beta keeps filling gaps — tests reservation mode under deep inversion',
    phase: 6,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // org-gamma: continuous medium jobs that saturate cluster (32 CPU, 3h, every 2m)
          { name: 'Gamma-fill-32cpu',   orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 10800, intervalSeconds: 120,  userPriority: 3, toolPriority: 3 },
          // deeporigin: 5 critical large jobs (256 CPU, 1h, every ~4.8h)
          { name: 'Alpha-critical-256', orgId: 'deeporigin', cpu: 256, memory: 1024, gpu: 0, durationSeconds: 3600,  intervalSeconds: 17280, userPriority: 5, toolPriority: 5 },
          // org-beta: opportunistic small jobs that try to fill gaps (4 CPU, 10m, every 2m)
          { name: 'Beta-opportunistic', orgId: 'org-beta',   cpu: 4,   memory: 16,   gpu: 0, durationSeconds: 600,   intervalSeconds: 120,  userPriority: 1, toolPriority: 1 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10002,
    },
  },
  {
    id: 'ttl-expiry-cascade',
    name: 'A3: TTL Expiry Cascade',
    description: 'Deliberate overload at 60 jobs/hr with mixed sizes and 2h TTL — tests queue churn as expired jobs cascade (set TTL to 7200s in config)',
    phase: 6,
    workloadConfig: {
      durationSeconds: 43200,
      arrivalPattern: { type: 'poisson', lambdaPerMinute: 1.0 },
      sizeDistribution: { type: 'mixed', small: 50, medium: 35, large: 15 },
      seed: 10003,
    },
  },
  {
    id: 'starvation-gauntlet',
    name: 'A4: Starvation Gauntlet',
    description: 'Worst-case aging: deeporigin + org-beta saturate cluster continuously, org-gamma submits a single 16-CPU job — tests whether aging guarantees eventual execution',
    phase: 6,
    workloadConfig: {
      durationSeconds: 86400,
      arrivalPattern: {
        type: 'periodic_mix',
        templates: [
          // deeporigin: continuous 128-CPU stream every 10m (max priority)
          { name: 'Alpha-stream-128cpu', orgId: 'deeporigin', cpu: 128, memory: 512,  gpu: 0, durationSeconds: 7200,  intervalSeconds: 600,  userPriority: 5, toolPriority: 5 },
          // org-beta: continuous 64-CPU stream every 10m (high priority)
          { name: 'Beta-stream-64cpu',   orgId: 'org-beta',   cpu: 64,  memory: 256,  gpu: 0, durationSeconds: 7200,  intervalSeconds: 600,  userPriority: 4, toolPriority: 4 },
          // org-gamma: SINGLE 16-CPU job (submitted once at start, lowest priority)
          { name: 'Gamma-single-16cpu',  orgId: 'org-gamma',  cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 86400, userPriority: 1, toolPriority: 1 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10004,
    },
  },
  {
    id: 'oscillating-demand',
    name: 'A5: Oscillating Demand',
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
