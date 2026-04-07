/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark Module — Barrel Export
 * ========================================
 * Everything needed to run benchmarks from the UI or programmatically.
 *
 * Usage:
 *   import { runBenchmarkSuite, SCENARIO_PRESETS, getFormulas } from '@/lib/benchmark';
 */

// Metrics
export { computeMetrics, percentile, jainsIndex } from './metrics';
export type { JobEvent, UtilizationSample, ComputedMetrics, OrgMetrics } from './metrics';

// Traffic generators
export { SeededRandom, generateWorkload, generateArrivalTimes, generateJobSize, SCENARIO_PRESETS } from './traffic';
export type { GeneratedJob, ArrivalPattern, JobSizeDistribution, WorkloadConfig, ScenarioPreset, MMPPState } from './traffic';

// DES Engine
export { runDES, runDESAsync } from './des-engine';
export type { DESConfig, DESResult, ScoringFunction } from './des-engine';

// Statistical rigor
export { detectWarmUp, confidenceInterval, pairedTTest, requiredSampleSize, aggregateMetrics, compareScenarios } from './statistics';
export type { ConfidenceInterval, PairedTestResult, AggregatedMetrics, ScenarioComparison } from './statistics';

// Scoring formula registry
export { getFormulas, getFormula, registerFormula, createScoreFn } from './scoring';
export type { ScoreFn, ScoringFormula } from './scoring';

// Runner (orchestrator)
export { runBenchmarkSuite, quickRun } from './runner';
export type { BenchmarkScenarioConfig, BenchmarkSuiteConfig, ScenarioResult, BenchmarkSuiteResult, ProgressCallback } from './runner';

// Export utilities (per-scenario)
export { exportCSV, exportJSON, exportMarkdown } from './export';

// Consolidated report exports (multi-scenario)
export {
  exportPDFReport,
  exportMarkdownReport,
  exportJSONReport,
  exportCSVReport,
} from './export-report';

// Re-export store types used by components
export type { MultiScenarioEntry } from '../benchmark-store';
