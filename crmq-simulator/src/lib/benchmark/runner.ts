/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Runner
 * =========================
 * Orchestrates full benchmark suites:
 *
 *   1. Generates workloads from traffic models
 *   2. Runs N replications per scenario via the DES engine
 *   3. Collects metrics with warm-up filtering
 *   4. Aggregates results with confidence intervals
 *   5. Compares scenarios with paired t-tests
 *
 * Can run entirely in the browser (Web Worker friendly) or in Node.
 */

import type { CRMQConfig, Org } from '../types';
import { vcpuFromCpuMillis } from '../units';
import { runDES, runDESAsync } from './des-engine';
import type { DESConfig, DESResult } from './des-engine';
import { computeMetrics } from './metrics';
import { getFormula } from './scoring';
import type { ComputedMetrics } from './metrics';
import { generateWorkload } from './traffic';
import type { ArrivalPattern, JobSizeDistribution, GeneratedJob } from './traffic';
import { detectWarmUp, aggregateMetrics, compareScenarios } from './statistics';
import type { AggregatedMetrics, ScenarioComparison } from './statistics';

// ── Benchmark Suite Configuration ─────────────────────────────────────────

export interface BenchmarkScenarioConfig {
  id: string;
  name: string;
  /** CRMQ config to use for this scenario */
  config: CRMQConfig;
  /** Orgs for this scenario */
  orgs: Org[];
  /** Optional: override the formula used (by ID from scoring registry) */
  formulaId?: string;
}

export interface BenchmarkSuiteConfig {
  /** Name of this benchmark suite */
  name: string;
  /** Scenarios to compare (different configs/formulas) */
  scenarios: BenchmarkScenarioConfig[];
  /** Workload generation parameters */
  workload: {
    durationSeconds: number;
    arrivalPattern: ArrivalPattern;
    sizeDistribution: JobSizeDistribution;
    ttlDefault: number;
  };
  /** Number of replications per scenario (§5.5: minimum 30) */
  replications: number;
  /** Base random seed (each replication uses seed + i) */
  baseSeed: number;
  /** Maximum sim-time per run (safety cap) */
  maxSimTime?: number;
  /** Whether to auto-detect warm-up or use a fixed value */
  warmUp: { type: 'auto' } | { type: 'fixed'; seconds: number };
}

// ── Run Result ────────────────────────────────────────────────────────────

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  /** Raw metrics from each replication */
  rawMetrics: ComputedMetrics[];
  /** Aggregated metrics with confidence intervals */
  aggregated: AggregatedMetrics;
  /** Per-run DES stats (for debugging) */
  runStats: Array<{
    seed: number;
    simDuration: number;
    totalEvents: number;
    warmUpTime: number;
  }>;
}

export interface BenchmarkSuiteResult {
  name: string;
  startedAt: number;
  completedAt: number;
  scenarios: ScenarioResult[];
  /** Pairwise comparisons between scenarios */
  comparisons: ScenarioComparison[];
}

// ── Progress Callback ─────────────────────────────────────────────────────

export type ProgressCallback = (progress: {
  phase: 'generating' | 'running' | 'analyzing';
  scenarioIndex: number;
  replicationIndex: number;
  totalScenarios: number;
  totalReplications: number;
  pct: number;  // 0–100
}) => void;

// ── Runner ────────────────────────────────────────────────────────────────

/**
 * Yield control back to the browser so the UI stays responsive.
 * Uses MessageChannel instead of setTimeout because browsers
 * throttle setTimeout to ~1s in background tabs, which would
 * stall the entire benchmark when the user switches tabs/apps.
 * MessageChannel.postMessage is NOT subject to this throttling.
 */
const yieldToMain = (): Promise<void> =>
  new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });

/**
 * Run a full benchmark suite (async — yields to browser between DES runs).
 *
 * For each scenario × each replication:
 *   1. Generate workload (same seed per replication across scenarios for paired comparison)
 *   2. Run headless DES
 *   3. Detect warm-up
 *   4. Compute metrics (post warm-up only)
 *
 * Then aggregate and compare.
 */
export const runBenchmarkSuite = async (
  suiteConfig: BenchmarkSuiteConfig,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<BenchmarkSuiteResult> => {
  const startedAt = Date.now();
  const { scenarios, workload, replications, baseSeed, maxSimTime } = suiteConfig;


  const totalWork = scenarios.length * replications;
  let workDone = 0;

  // ── Per-scenario results ──────────────────────────────────────────────

  const scenarioResults: ScenarioResult[] = [];

  for (let si = 0; si < scenarios.length; si++) {
    const scenario = scenarios[si];
    const rawMetrics: ComputedMetrics[] = [];
    const runStats: ScenarioResult['runStats'] = [];

    for (let ri = 0; ri < replications; ri++) {
      const seed = baseSeed + ri;

      onProgress?.({
        phase: ri === 0 && si === 0 ? 'generating' : 'running',
        scenarioIndex: si,
        replicationIndex: ri,
        totalScenarios: scenarios.length,
        totalReplications: replications,
        pct: Math.round((workDone / totalWork) * 100),
      });

      // Yield to browser every run so the UI can repaint progress
      await yieldToMain();

      // Check for cancellation
      if (signal?.aborted) {
        throw new DOMException('Benchmark cancelled', 'AbortError');
      }

      // Generate workload (same seed for paired comparison)
      const wl = generateWorkload({
        durationSeconds: workload.durationSeconds,
        arrivalPattern: workload.arrivalPattern,
        sizeDistribution: workload.sizeDistribution,
        orgs: scenario.orgs,
        ttlDefault: workload.ttlDefault,
        seed,
      });


      // Run DES — with the scenario's scoring formula.
      // Use synchronous runDES when in a worker
      // (faster, no yield overhead), and async on
      // the main thread as a fallback.
      const formula = scenario.formulaId
        ? getFormula(scenario.formulaId)
        : undefined;
      const desConfig: DESConfig = {
        config: scenario.config,
        orgs: scenario.orgs,
        workload: wl,
        maxSimTime:
          maxSimTime ??
          workload.durationSeconds * 3,
        scoringFn: formula?.score,
      };

      const inWorker =
        typeof self !== 'undefined' &&
        typeof (self as unknown as { Window?: unknown }).Window === 'undefined';

      const desResult = inWorker
        ? runDES(desConfig)
        : await runDESAsync(
            desConfig,
            2000,
            signal,
          );

      // Detect warm-up
      let warmUpTime = 0;
      if (suiteConfig.warmUp.type === 'auto') {
        // Build utilization time-series for warm-up detection
        // Only consider samples during the arrival period — after arrivals stop
        // the system is draining (non-stationary) and shouldn't be used for detection.
        const arrivalEnd = workload.durationSeconds;
        const utilSeries = desResult.utilSamples
          .filter(s => s.time <= arrivalEnd)
          .map(s => {
            const totalCpu = Object.values(s.pools).reduce((a, p) => a + vcpuFromCpuMillis(p.total.cpuMillis), 0);
            const usedCpu = Object.values(s.pools).reduce((a, p) => a + vcpuFromCpuMillis(p.used.cpuMillis), 0);
            return { time: s.time, utilization: totalCpu > 0 ? usedCpu / totalCpu : 0 };
          });
        warmUpTime = detectWarmUp(utilSeries);
        // Cap warm-up to 25% of the arrival period — steady-state analysis
        // needs at least 75% of the workload's arrivals to be meaningful
        warmUpTime = Math.min(warmUpTime, arrivalEnd * 0.25);
      } else {
        warmUpTime = suiteConfig.warmUp.seconds;
      }

      // Compute metrics (filtered to post-warm-up)
      const metrics = computeMetrics(
        desResult.events,
        desResult.utilSamples,
        scenario.config,
        scenario.orgs,
        desResult.simDuration,
        warmUpTime,
      );

      rawMetrics.push(metrics);
      runStats.push({
        seed,
        simDuration: desResult.simDuration,
        totalEvents: desResult.totalEventsProcessed,
        warmUpTime,
      });

      workDone++;
    }

    // Aggregate across replications
    const aggregated = aggregateMetrics(rawMetrics);

    scenarioResults.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      rawMetrics,
      aggregated,
      runStats,
    });
  }

  // ── Pairwise comparisons ──────────────────────────────────────────────

  onProgress?.({
    phase: 'analyzing',
    scenarioIndex: scenarios.length - 1,
    replicationIndex: replications - 1,
    totalScenarios: scenarios.length,
    totalReplications: replications,
    pct: 95,
  });

  const comparisons: ScenarioComparison[] = [];
  for (let i = 0; i < scenarioResults.length; i++) {
    for (let j = i + 1; j < scenarioResults.length; j++) {
      const a = scenarioResults[i];
      const b = scenarioResults[j];
      comparisons.push(
        compareScenarios(a.scenarioName, a.rawMetrics, b.scenarioName, b.rawMetrics),
      );
    }
  }

  onProgress?.({
    phase: 'analyzing',
    scenarioIndex: scenarios.length - 1,
    replicationIndex: replications - 1,
    totalScenarios: scenarios.length,
    totalReplications: replications,
    pct: 100,
  });

  return {
    name: suiteConfig.name,
    startedAt,
    completedAt: Date.now(),
    scenarios: scenarioResults,
    comparisons,
  };
};

// ── Quick Run (single scenario, single replication — for testing) ───────

export const quickRun = (
  config: CRMQConfig,
  orgs: Org[],
  workload: GeneratedJob[],
): { metrics: ComputedMetrics; desResult: DESResult } => {
  const desResult = runDES({ config, orgs, workload });
  const metrics = computeMetrics(
    desResult.events,
    desResult.utilSamples,
    config,
    orgs,
    desResult.simDuration,
  );
  return { metrics, desResult };
};
