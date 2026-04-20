import { SCENARIO_PRESETS, generateWorkload } from './src/lib/benchmark/traffic';
import { quickRun } from './src/lib/benchmark/runner';
import { DEFAULT_CONFIG, DEFAULT_ORGS } from './src/lib/scheduler';
import type { CRMQConfig } from './src/lib/types';

const sc = SCENARIO_PRESETS.find(s => s.id === 'priority-size-inversion');
if (!sc) { console.log('Scenario not found'); process.exit(1); }
const jobs = generateWorkload({
  ...sc.workloadConfig,
  orgs: DEFAULT_ORGS,
  ttlDefault: DEFAULT_CONFIG.ttlDefault,
});
console.log('Total jobs:', jobs.length);

const formulas = [
  'current_weighted',
  'normalized_weighted_sum',
  'drf_fair_share',
  'balanced_composite',
  'strict_fifo',
] as const;

for (const f of formulas) {
  const config: CRMQConfig = {
    ...DEFAULT_CONFIG,
    formulaType: f,
  };
  const t0 = Date.now();
  const { metrics: m } = quickRun(config, DEFAULT_ORGS, jobs);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const firstUtil = Object.values(m.utilization)[0];
  const cpuPct = (firstUtil?.cpu ?? 0) * 100;
  console.log(
    `${f.padEnd(26)} ${elapsed}s`
    + ` | avgWait=${m.meanWaitTime.toFixed(0).padStart(5)}s`
    + ` | p99Wait=${m.p99WaitTime.toFixed(0).padStart(6)}s`
    + ` | fairness=${m.jainsIndex.toFixed(3)}`
    + ` | util_cpu=${cpuPct.toFixed(1)}%`
  );
  // Per-org breakdown
  for (const [org, om] of Object.entries(m.orgMetrics)) {
    console.log(
      `  ${org.padEnd(14)}`
      + ` jobs=${om.jobsCompleted}/${om.jobsSubmitted}`
      + ` meanWait=${om.meanWaitTime.toFixed(0)}s`
      + ` p95Wait=${om.p95WaitTime.toFixed(0)}s`
    );
  }
}
