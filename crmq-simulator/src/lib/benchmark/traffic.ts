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
          { name: 'DO-large-64cpu',     orgId: 'deeporigin', cpu: 64,  memory: 256,  gpu: 0, durationSeconds: 180, intervalSeconds: 30,  userPriority: 4, toolPriority: 4 },
          // org-beta: small 4-CPU jobs every 2s (30/min)
          // 120s / 2s = 60 concurrent × 4 = 240 CPU (within 384 quota)
          // Floods queue with volume, low priority org (2)
          { name: 'Beta-small-4cpu',    orgId: 'org-beta',   cpu: 4,   memory: 16,   gpu: 0, durationSeconds: 120, intervalSeconds: 2,   userPriority: 2, toolPriority: 2 },
          // org-gamma: medium 32-CPU jobs every 10s (6/min)
          // 300s / 10s = 30 concurrent × 32 = 960 CPU demand,
          // but quota caps at 12 concurrent (384 CPU)
          // Lowest priority org (1), creates real quota contention
          { name: 'Gamma-med-32cpu',    orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 300, intervalSeconds: 10,  userPriority: 3, toolPriority: 3 },
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
          { name: 'DO-large-96cpu',     orgId: 'deeporigin', cpu: 96,  memory: 384, gpu: 0, durationSeconds: 14400, intervalSeconds: 2700, userPriority: 3, toolPriority: 4 },
          // org-beta: 48 CPU, 2h, every 15min = 8 concurrent × 48 = 384 CPU (= quota)
          { name: 'Beta-med-48cpu',     orgId: 'org-beta',   cpu: 48,  memory: 192, gpu: 0, durationSeconds: 7200,  intervalSeconds: 900,  userPriority: 2, toolPriority: 3 },
          // org-gamma: 64 CPU, 3h, every 20min = 9 concurrent × 64 = 576 demand,
          // quota caps at 384 (6 running, 3 queued)
          { name: 'Gamma-med-64cpu',    orgId: 'org-gamma',  cpu: 64,  memory: 256, gpu: 0, durationSeconds: 10800, intervalSeconds: 1200, userPriority: 3, toolPriority: 3 },
          // Background small jobs to fill gaps
          // DO: 2700/300 = 9 × 8 = 72 CPU
          { name: 'BG-deeporigin-8cpu', orgId: 'deeporigin', cpu: 8,   memory: 32,  gpu: 0, durationSeconds: 2700,  intervalSeconds: 300,  userPriority: 2, toolPriority: 2 },
          // Beta: 600/120 = 5 × 4 = 20 CPU
          { name: 'BG-beta-4cpu',       orgId: 'org-beta',   cpu: 4,   memory: 16,  gpu: 0, durationSeconds: 600,   intervalSeconds: 120,  userPriority: 1, toolPriority: 1 },
          // Gamma: 1800/300 = 6 × 8 = 48 CPU
          { name: 'BG-gamma-8cpu',      orgId: 'org-gamma',  cpu: 8,   memory: 32,  gpu: 0, durationSeconds: 1800,  intervalSeconds: 300,  userPriority: 2, toolPriority: 2 },
        ],
        // Total running: DO 584 + beta min(404,384) + gamma min(624,384) = ~1,352
        // Plus bg: 72 + 20 + 48 = 140. Effective ~1,352+ (pool = 1,362).
        // Both beta and gamma hit quota walls → formula decides who gets scarce slots.
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
          { name: 'Flood-8cpu',         orgId: 'org-beta',   cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 30,   userPriority: 1, toolPriority: 1 },
          // deeporigin critical: 128 CPU, 2h, every 1h = 24/day
          // 7200s/3600s = 2 concurrent × 128 = 256 CPU
          { name: 'Critical-128cpu',    orgId: 'deeporigin', cpu: 128, memory: 512,  gpu: 0, durationSeconds: 7200,  intervalSeconds: 3600, userPriority: 5, toolPriority: 5 },
          // deeporigin background: 32 CPU, 1h, every 5min
          // 3600s/300s = 12 concurrent × 32 = 384 CPU
          { name: 'DO-background-32cpu', orgId: 'deeporigin', cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 300,  userPriority: 3, toolPriority: 3 },
          // org-gamma normal: 32 CPU, 1h, every 4min
          // 3600s/240s = 15 concurrent × 32 = 480 demand,
          // quota caps at 384 (12 running, 3 queued)
          { name: 'Normal-32cpu',       orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 240,  userPriority: 3, toolPriority: 3 },
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
          { name: 'WHALE-768cpu',       orgId: 'deeporigin', cpu: 768, memory: 3072, gpu: 0, durationSeconds: 14400, intervalSeconds: 18000, userPriority: 5, toolPriority: 5 },
          // deeporigin medium: 16 CPU, 1h, every 10min = 6 × 16 = 96 CPU
          { name: 'Medium-DO-16cpu',    orgId: 'deeporigin', cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 3600,  intervalSeconds: 600,  userPriority: 3, toolPriority: 3 },
          // org-beta: 16 CPU every 45s, 20min dur = 26.7 concurrent × 16
          // = 427 demand, quota caps at 384 (24 running)
          { name: 'BG-beta-16cpu',      orgId: 'org-beta',   cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1200,  intervalSeconds: 45,   userPriority: 2, toolPriority: 2 },
          // org-gamma: 16 CPU every 50s, 15min dur = 18 concurrent × 16
          // = 288 CPU (within 384 quota)
          { name: 'BG-gamma-16cpu',     orgId: 'org-gamma',  cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 900,   intervalSeconds: 50,   userPriority: 2, toolPriority: 3 },
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
          // Max throughput ≈ 1.48 jobs/min for this heavier mix.
          // Normal operation: 1/min ≈ 67% utilisation
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
          // Max throughput ≈ 2.1 jobs/min for this mixed distribution.
          // Night: 0.5/min ≈ 25% utilisation — queue drains
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
          { name: 'DO-prep-8cpu',         orgId: 'deeporigin', cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 900,   intervalSeconds: 300, userPriority: 3, toolPriority: 3 },
          // 3600/360 = 10 × 32 = 320 CPU
          { name: 'DO-compute-32cpu',     orgId: 'deeporigin', cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 360, userPriority: 3, toolPriority: 4 },
          // GPU pool: 7200/720 = 10 × (16 CPU, 8 GPU)
          { name: 'DO-gpu-8gpu',          orgId: 'deeporigin', cpu: 16,  memory: 64,   gpu: 8, durationSeconds: 7200,  intervalSeconds: 720, userPriority: 3, toolPriority: 5 },
          // org-beta: prep + compute (CPU pool)
          // 1800/300 = 6 × 16 = 96 CPU
          { name: 'Beta-prep-16cpu',      orgId: 'org-beta',   cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 300, userPriority: 2, toolPriority: 3 },
          // 3600/360 = 10 × 64 = 640 demand, quota caps at 384
          // (6 running, 4 queued per cycle)
          { name: 'Beta-compute-64cpu',   orgId: 'org-beta',   cpu: 64,  memory: 256,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 360, userPriority: 2, toolPriority: 4 },
          // org-gamma: analysis + compute + background
          // 1800/240 = 7.5 × 16 = 120 CPU
          { name: 'Gamma-analysis-16cpu', orgId: 'org-gamma',  cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 240, userPriority: 2, toolPriority: 2 },
          // 3600/480 = 7.5 × 32 = 240 CPU demand → gamma total 360 (within 384)
          { name: 'Gamma-compute-32cpu',  orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 480, userPriority: 2, toolPriority: 3 },
          // 1800/120 = 15 × 8 = 120 CPU → gamma total 480, quota caps at 384
          { name: 'BG-standalone-cpu',    orgId: 'org-gamma',  cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 120, userPriority: 1, toolPriority: 1 },
          // GPU pool: org-beta GPU jobs
          { name: 'BG-standalone-gpu',    orgId: 'org-beta',   cpu: 16,  memory: 64,   gpu: 4, durationSeconds: 3600,  intervalSeconds: 720, userPriority: 2, toolPriority: 2 },
        ],
        // CPU pool: DO 344 + beta min(480,384) + gamma min(480,384) = ~1,112
        // With beta & gamma queuing, effective ~1,112 running + queued pressure.
        // GPU pool: DO 160 CPU + beta 80 CPU = 240 CPU, 80+20 = 100 GPU
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
          { name: 'MolProps-prep-8cpu',    orgId: 'deeporigin', cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 900,   intervalSeconds: 180,  userPriority: 3, toolPriority: 3 },
          // Stage 2: Compute — every 6 min (10/hr)
          // 3600/360 = 10 × 32 = 320 CPU
          { name: 'MolProps-main-32cpu',   orgId: 'deeporigin', cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 360,  userPriority: 3, toolPriority: 4 },
          // Stage 3: GPU finish — every 12 min (5/hr)
          // 7200/720 = 10 × (16 CPU, 8 GPU) = 160 CPU, 80 GPU
          { name: 'MolProps-gpu-8gpu',     orgId: 'deeporigin', cpu: 16,  memory: 64,   gpu: 8, durationSeconds: 7200,  intervalSeconds: 720,  userPriority: 3, toolPriority: 5 },

          // ── Docking pipeline (org-beta) ──
          // Stage 1: Prep — every 3 min
          // 1200/180 = 6.7 × 16 = 107 CPU
          { name: 'Docking-prep-16cpu',    orgId: 'org-beta',   cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 1200,  intervalSeconds: 180,  userPriority: 2, toolPriority: 3 },
          // Stage 2: Main — every 8 min
          // 3600/480 = 7.5 × 64 = 480 demand, quota caps at 384
          { name: 'Docking-main-64cpu',    orgId: 'org-beta',   cpu: 64,  memory: 256,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 480,  userPriority: 2, toolPriority: 4 },

          // ── Analysis pipeline (org-gamma) ──
          // Stage 1: Prep — every 3 min
          // 600/180 = 3.3 × 8 = 27 CPU
          { name: 'Analysis-prep-8cpu',    orgId: 'org-gamma',  cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 600,   intervalSeconds: 180,  userPriority: 2, toolPriority: 2 },
          // Stage 2: Main — every 6 min
          // 1800/360 = 5 × 32 = 160 CPU
          { name: 'Analysis-main-32cpu',   orgId: 'org-gamma',  cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 1800,  intervalSeconds: 360,  userPriority: 2, toolPriority: 3 },

          // Background standalone jobs (org-gamma)
          // 1800/120 = 15 × 8 = 120 CPU → gamma total ~307, within 384
          { name: 'BG-standalone-cpu',     orgId: 'org-gamma',  cpu: 8,   memory: 32,   gpu: 0, durationSeconds: 1800,  intervalSeconds: 120,  userPriority: 1, toolPriority: 1 },
        ],
        // CPU pool: DO 360 + beta min(491,384) + gamma 307 = ~1,051 running
        // Plus queued beta compute jobs creating scoring contention.
        // GPU pool: DO 160 CPU, 80 GPU → moderate GPU pressure.
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 9004,
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
            cpu: 32,
            memory: 128,
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
            cpu: 128,
            memory: 512,
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
            cpu: 4,
            memory: 16,
            gpu: 0,
            durationSeconds: 7200,
            intervalSeconds: 38,
            userPriority: 3,
            toolPriority: 3,
          },
        ],
      },
      sizeDistribution: {
        type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0,
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
          { name: 'Gamma-fill-16cpu',   orgId: 'org-gamma',  cpu: 16,  memory: 64,   gpu: 0, durationSeconds: 10800, intervalSeconds: 120,  userPriority: 2, toolPriority: 2 },
          // org-beta: 32 CPU jobs, 2h duration, every 2 min
          // 7200s / 120s = 60 arrivals per 2h window, quota caps at
          // 12 concurrent (12 × 32 = 384 CPU = quota limit)
          { name: 'Beta-fill-32cpu',    orgId: 'org-beta',   cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 7200,  intervalSeconds: 120,  userPriority: 2, toolPriority: 2 },
          // deeporigin background: 32 CPU jobs, 1h, every 3 min
          // 3600s / 180s = 20 concurrent × 32 = 640 CPU demand,
          // but cluster headroom after gamma+beta = ~594 CPU,
          // so ~18 concurrent fit (576 CPU). Total occupied: ~1,344 CPU.
          // Only ~18 CPU free — the 256-CPU critical job CANNOT fit.
          { name: 'DO-background-32cpu', orgId: 'deeporigin', cpu: 32,  memory: 128,  gpu: 0, durationSeconds: 3600,  intervalSeconds: 180,  userPriority: 3, toolPriority: 3 },
          // deeporigin critical: 5 large jobs (256 CPU, 1h, every ~4.8h)
          // Must trigger reservation mode to accumulate 256 free CPU
          // by blocking new dispatches until enough jobs complete.
          { name: 'DO-critical-256cpu', orgId: 'deeporigin', cpu: 256, memory: 1024, gpu: 0, durationSeconds: 3600,  intervalSeconds: 17280, userPriority: 5, toolPriority: 5 },
        ],
      },
      sizeDistribution: { type: 'fixed', cpu: 0, memory: 0, gpu: 0, duration: 0 },
      seed: 10002,
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
