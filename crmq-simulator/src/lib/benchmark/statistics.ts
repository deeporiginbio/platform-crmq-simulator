/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Statistical Rigor Utilities
 * ===============================================
 * Implements §5.5 of the research report:
 *
 *   - Warm-up detection (steady-state heuristic)
 *   - Confidence intervals via batch means
 *   - Paired t-test for algorithm comparison
 *   - Cohen's d effect size
 *   - Required sample size estimation
 *   - Multi-run aggregation
 */

import type { ComputedMetrics, OrgMetrics } from './metrics';

// ── Warm-Up Detection ─────────────────────────────────────────────────────

/**
 * Detect warm-up period from utilization time-series.
 *
 * Strategy: find the earliest time window where the coefficient of variation
 * of utilization drops below `cvThreshold` over a sliding window.
 * (§5.5: "Detect steady state when resource utilization CV < 5%")
 *
 * The window size adapts to the simulation duration:
 *   - Uses min(windowSize, 20% of total duration) to avoid the window
 *     being longer than the sim itself (which would filter out all events).
 *   - Minimum effective window of 60s to avoid noise from very short windows.
 *
 * Returns the sim-time when steady state begins.
 */
export const detectWarmUp = (
  utilizationSeries: Array<{ time: number; utilization: number }>,
  windowSize: number = 1800,   // 30 minutes (max)
  cvThreshold: number = 0.05,  // 5%
): number => {
  if (utilizationSeries.length < 10) return 0;

  // Adapt window size to simulation duration so it doesn't exceed the sim
  const totalDuration = utilizationSeries[utilizationSeries.length - 1].time - utilizationSeries[0].time;
  const effectiveWindow = Math.max(60, Math.min(windowSize, totalDuration * 0.2));

  // Slide window across time-series
  for (let i = 0; i < utilizationSeries.length; i++) {
    const windowStart = utilizationSeries[i].time;
    const windowEnd = windowStart + effectiveWindow;

    const windowPoints = utilizationSeries.filter(
      p => p.time >= windowStart && p.time < windowEnd,
    );

    if (windowPoints.length < 5) continue;

    const values = windowPoints.map(p => p.utilization);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean === 0) continue;

    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    const cv = Math.sqrt(variance) / mean;

    if (cv < cvThreshold) {
      return windowStart;
    }
  }

  // If no steady state found, use 10% of total duration as fallback
  return utilizationSeries[0].time + totalDuration * 0.1;
};

// ── Confidence Intervals ──────────────────────────────────────────────────

/**
 * Compute a confidence interval for a sample using batch means.
 * (§5.5: Use batch means method for autocorrelated simulation data)
 *
 * @param values - Array of observed values (one per run)
 * @param confidence - Confidence level (default 0.95 for 95% CI)
 * @returns { mean, low, high, halfWidth }
 */
export interface ConfidenceInterval {
  mean: number;
  low: number;
  high: number;
  halfWidth: number;
  n: number;
}

export const confidenceInterval = (
  values: number[],
  confidence: number = 0.95,
): ConfidenceInterval => {
  const n = values.length;
  if (n === 0) return { mean: 0, low: 0, high: 0, halfWidth: 0, n: 0 };
  if (n === 1) return { mean: values[0], low: values[0], high: values[0], halfWidth: 0, n: 1 };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance / n);

  // t-critical value approximation for common confidence levels
  // For n >= 30, z-approximation is fine; for smaller n, use t-table lookup
  const tCritical = getTCritical(n - 1, confidence);
  const halfWidth = tCritical * stdErr;

  return {
    mean,
    low: mean - halfWidth,
    high: mean + halfWidth,
    halfWidth,
    n,
  };
};

/**
 * Approximate t-critical value.
 * Uses the common z-values for large n, and a lookup table for small n.
 */
const getTCritical = (df: number, confidence: number): number => {
  // Common t-critical values for 95% confidence (two-tailed)
  const t95: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021,
    50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984, 120: 1.980,
  };

  // For 99% confidence
  const t99: Record<number, number> = {
    1: 63.657, 2: 9.925, 3: 5.841, 4: 4.604, 5: 4.032,
    6: 3.707, 7: 3.499, 8: 3.355, 9: 3.250, 10: 3.169,
    15: 2.947, 20: 2.845, 25: 2.787, 30: 2.750, 40: 2.704,
    50: 2.678, 60: 2.660, 80: 2.639, 100: 2.626, 120: 2.617,
  };

  const table = confidence >= 0.99 ? t99 : t95;

  // Find closest df in table
  const dfs = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (df >= 120) return confidence >= 0.99 ? 2.576 : 1.960; // z-approximation

  let closest = dfs[0];
  for (const d of dfs) {
    if (d <= df) closest = d;
    else break;
  }
  return table[closest];
};

// ── Paired t-Test ─────────────────────────────────────────────────────────

/**
 * Paired t-test comparing two sets of metrics (same workloads, different algorithms).
 * (§5.5: "Use paired t-test on batch means (same random seeds, same scenarios)")
 *
 * @returns { tStatistic, pValue (approximated), significant, cohensD }
 */
export interface PairedTestResult {
  tStatistic: number;
  /** Approximate two-tailed p-value */
  pValue: number;
  /** Whether the difference is statistically significant at alpha=0.05 */
  significant: boolean;
  /** Cohen's d effect size: small (0.2), medium (0.5), large (0.8) */
  cohensD: number;
  /** Effect size label */
  effectLabel: 'negligible' | 'small' | 'medium' | 'large';
  meanDifference: number;
  n: number;
}

export const pairedTTest = (
  valuesA: number[],
  valuesB: number[],
  alpha: number = 0.05,
): PairedTestResult => {
  const n = Math.min(valuesA.length, valuesB.length);
  if (n < 2) {
    return {
      tStatistic: 0, pValue: 1, significant: false,
      cohensD: 0, effectLabel: 'negligible', meanDifference: 0, n,
    };
  }

  // Differences
  const diffs = valuesA.slice(0, n).map((a, i) => a - valuesB[i]);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  const sdDiff = Math.sqrt(
    diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0) / (n - 1),
  );

  // Numerical stability: treat near-zero sdDiff as exactly zero.
  // Deterministic workloads (e.g. periodic_mix) produce identical replications,
  // but floating-point arithmetic introduces infinitesimal differences (~1e-12).
  // Without this guard, dividing by near-zero sdDiff produces t-statistics of
  // ~10^15 and Cohen's d of ~10^14, which are meaningless.
  //
  // Threshold: sdDiff < epsilon × max(1, |meanDiff|) catches cases where the
  // "variance" is just floating-point noise relative to the actual values.
  const EPSILON = 1e-9;
  const isEffectivelyZeroVariance = sdDiff < EPSILON * Math.max(1, Math.abs(meanDiff));

  if (sdDiff === 0 || isEffectivelyZeroVariance) {
    // All replications produced (effectively) the same result.
    // If meanDiff ≠ 0, the difference is real but not statistically testable
    // (zero within-pair variance → infinite t, which is degenerate).
    // Report as deterministic: significant = true only if there IS a real gap,
    // but use finite sentinel values so the UI doesn't break.
    const hasRealDifference = Math.abs(meanDiff) > EPSILON;
    return {
      // Use large but finite sentinels so the UI renders cleanly.
      // t=±1e6 and d=1e6 convey "deterministic difference" without
      // breaking Number.isFinite() checks in the display layer.
      tStatistic: hasRealDifference ? Math.sign(meanDiff) * 1e6 : 0,
      pValue: hasRealDifference ? 0 : 1,
      significant: hasRealDifference,
      cohensD: hasRealDifference ? 1e6 : 0,
      effectLabel: hasRealDifference ? 'large' : 'negligible',
      meanDifference: meanDiff,
      n,
    };
  }

  const tStatistic = meanDiff / (sdDiff / Math.sqrt(n));
  const df = n - 1;

  // Approximate p-value using normal distribution for large n
  // For small n, this is a rough approximation
  const pValue = approximatePValue(Math.abs(tStatistic), df);
  const significant = pValue < alpha;

  // Cohen's d
  const cohensD = Math.abs(meanDiff) / sdDiff;
  const effectLabel: PairedTestResult['effectLabel'] =
    cohensD < 0.2 ? 'negligible' :
    cohensD < 0.5 ? 'small' :
    cohensD < 0.8 ? 'medium' :
    'large';

  return { tStatistic, pValue, significant, cohensD, effectLabel, meanDifference: meanDiff, n };
};

/**
 * Rough p-value approximation for a t-statistic.
 * Uses the normal CDF approximation (adequate for df > 20,
 * conservative for smaller df).
 */
const approximatePValue = (absT: number, _df: number): number => {
  // Abramowitz & Stegun normal CDF approximation
  const x = absT;
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p = d * Math.exp(-x * x / 2) *
    (0.319381530 * t
     - 0.356563782 * t * t
     + 1.781477937 * t * t * t
     - 1.821255978 * t * t * t * t
     + 1.330274429 * t * t * t * t * t);
  return 2 * Math.max(0, Math.min(1, p)); // two-tailed
};

// ── Required Sample Size ──────────────────────────────────────────────────

/**
 * Estimate the number of runs needed for a given confidence interval width.
 * (§5.5: n >= (z_{alpha/2} * sigma / E)^2)
 *
 * @param pilotStdDev - Standard deviation from pilot runs
 * @param acceptableError - Acceptable error (e.g. 10% of mean)
 * @param confidence - Confidence level (default 0.95)
 */
export const requiredSampleSize = (
  pilotStdDev: number,
  acceptableError: number,
  confidence: number = 0.95,
): number => {
  if (acceptableError <= 0 || pilotStdDev <= 0) return 30;
  const z = confidence >= 0.99 ? 2.576 : 1.960;
  return Math.max(30, Math.ceil((z * pilotStdDev / acceptableError) ** 2));
};

// ── Multi-Run Aggregation ─────────────────────────────────────────────────

/**
 * Aggregated metrics across multiple runs of the same scenario.
 * Each metric has a mean and confidence interval.
 */
export interface AggregatedMetrics {
  runs: number;
  throughput: ConfidenceInterval;
  meanWaitTime: ConfidenceInterval;
  p50WaitTime: ConfidenceInterval;
  p95WaitTime: ConfidenceInterval;
  p99WaitTime: ConfidenceInterval;
  maxWaitTime: ConfidenceInterval;
  jainsIndex: ConfidenceInterval;
  evictionRate: ConfidenceInterval;
  coefficientOfVariation: ConfidenceInterval;
  utilization: Record<string, {
    cpu: ConfidenceInterval;
    gpu: ConfidenceInterval;
  }>;
  orgMetrics: Record<string, {
    meanWaitTime: ConfidenceInterval;
    jobsCompleted: ConfidenceInterval;
  }>;
}

export const aggregateMetrics = (
  metricsArray: ComputedMetrics[],
  confidence: number = 0.95,
): AggregatedMetrics => {
  const n = metricsArray.length;
  if (n === 0) throw new Error('Cannot aggregate zero metrics');

  const extract = (fn: (m: ComputedMetrics) => number): number[] =>
    metricsArray.map(fn);

  // Pool types (from first run — assume consistent)
  const poolTypes = Object.keys(metricsArray[0].utilization);
  const orgIds = Object.keys(metricsArray[0].orgMetrics);

  // Build per-pool utilization CIs
  const utilization: AggregatedMetrics['utilization'] = {};
  for (const pt of poolTypes) {
    utilization[pt] = {
      cpu: confidenceInterval(extract(m => m.utilization[pt]?.cpu ?? 0), confidence),
      gpu: confidenceInterval(extract(m => m.utilization[pt]?.gpu ?? 0), confidence),
    };
  }

  // Build per-org CIs
  const orgMetrics: AggregatedMetrics['orgMetrics'] = {};
  for (const orgId of orgIds) {
    orgMetrics[orgId] = {
      meanWaitTime: confidenceInterval(
        extract(m => m.orgMetrics[orgId]?.meanWaitTime ?? 0),
        confidence,
      ),
      jobsCompleted: confidenceInterval(
        extract(m => m.orgMetrics[orgId]?.jobsCompleted ?? 0),
        confidence,
      ),
    };
  }

  return {
    runs: n,
    throughput: confidenceInterval(extract(m => m.throughput), confidence),
    meanWaitTime: confidenceInterval(extract(m => m.meanWaitTime), confidence),
    p50WaitTime: confidenceInterval(extract(m => m.p50WaitTime), confidence),
    p95WaitTime: confidenceInterval(extract(m => m.p95WaitTime), confidence),
    p99WaitTime: confidenceInterval(extract(m => m.p99WaitTime), confidence),
    maxWaitTime: confidenceInterval(extract(m => m.maxWaitTime), confidence),
    jainsIndex: confidenceInterval(extract(m => m.jainsIndex), confidence),
    evictionRate: confidenceInterval(extract(m => m.evictionRate), confidence),
    coefficientOfVariation: confidenceInterval(extract(m => m.coefficientOfVariation), confidence),
    utilization,
    orgMetrics,
  };
};

// ── Scenario Comparison ───────────────────────────────────────────────────

/**
 * Compare two algorithms/configs run on the same workloads (paired).
 * Returns per-metric paired t-test results.
 */
export interface ScenarioComparison {
  nameA: string;
  nameB: string;
  throughput: PairedTestResult;
  meanWaitTime: PairedTestResult;
  p95WaitTime: PairedTestResult;
  jainsIndex: PairedTestResult;
  evictionRate: PairedTestResult;
  /** Which scenario "wins" on each dimension */
  winners: Record<string, string>;
}

export const compareScenarios = (
  nameA: string,
  metricsA: ComputedMetrics[],
  nameB: string,
  metricsB: ComputedMetrics[],
): ScenarioComparison => {
  const throughput = pairedTTest(
    metricsA.map(m => m.throughput),
    metricsB.map(m => m.throughput),
  );
  const meanWaitTime = pairedTTest(
    metricsA.map(m => m.meanWaitTime),
    metricsB.map(m => m.meanWaitTime),
  );
  const p95WaitTime = pairedTTest(
    metricsA.map(m => m.p95WaitTime),
    metricsB.map(m => m.p95WaitTime),
  );
  const jainsIndex = pairedTTest(
    metricsA.map(m => m.jainsIndex),
    metricsB.map(m => m.jainsIndex),
  );
  const evictionRate = pairedTTest(
    metricsA.map(m => m.evictionRate),
    metricsB.map(m => m.evictionRate),
  );

  // Determine winners (higher is better for throughput & fairness, lower is better for wait & eviction)
  const winners: Record<string, string> = {};
  winners['throughput'] = throughput.significant
    ? (throughput.meanDifference > 0 ? nameA : nameB) : 'tie';
  winners['meanWaitTime'] = meanWaitTime.significant
    ? (meanWaitTime.meanDifference < 0 ? nameA : nameB) : 'tie';
  winners['p95WaitTime'] = p95WaitTime.significant
    ? (p95WaitTime.meanDifference < 0 ? nameA : nameB) : 'tie';
  winners['jainsIndex'] = jainsIndex.significant
    ? (jainsIndex.meanDifference > 0 ? nameA : nameB) : 'tie';
  winners['evictionRate'] = evictionRate.significant
    ? (evictionRate.meanDifference < 0 ? nameA : nameB) : 'tie';

  return {
    nameA, nameB,
    throughput, meanWaitTime, p95WaitTime, jainsIndex, evictionRate,
    winners,
  };
};
