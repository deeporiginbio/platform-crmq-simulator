/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Export Utilities
 * ====================================
 * Exports benchmark results in CSV, JSON, and Markdown formats.
 */

import type { BenchmarkSuiteResult, ScenarioResult } from './runner';
import type {
  AggregatedMetrics,
  ConfidenceInterval,
  PairedTestResult,
  ScenarioComparison,
} from './statistics';
import type { ScenarioPreset, ArrivalPattern, JobSizeDistribution } from './traffic';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '../units';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtSec = (sec: number): string => {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
};

const fmtPct = (n: number): string =>
  Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';

const fmtNum = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toFixed(d) : '—';

const ciStr = (ci: ConfidenceInterval): string =>
  `${fmtNum(ci.mean)} [${fmtNum(ci.low)} – ${fmtNum(ci.high)}]`;

const ciTimeStr = (ci: ConfidenceInterval): string =>
  `${fmtSec(ci.mean)} [${fmtSec(ci.low)} – ${fmtSec(ci.high)}]`;

const ciPctStr = (ci: ConfidenceInterval): string =>
  `${fmtPct(ci.mean)} [${fmtPct(ci.low)} – ${fmtPct(ci.high)}]`;

const timestamp = (): string => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
};

// ── Trigger browser download ─────────────────────────────────────────────────

const download = (content: string, filename: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ── Scenario description helpers ────────────────────────────────────────────

const describeArrival = (p: ArrivalPattern): string => {
  switch (p.type) {
    case 'poisson': return `Poisson — ${p.lambdaPerMinute} jobs/min`;
    case 'uniform': return `Uniform — ${p.ratePerMinute} jobs/min`;
    case 'burst': return `Burst — ${p.count} jobs at t=${p.atTime}s`;
    case 'mmpp': return `MMPP — ${p.states.map(s => `${s.label}: ${s.lambdaPerMinute}/min (${(s.weight * 100).toFixed(0)}%)`).join(', ')}`;
    case 'periodic_mix': return `Periodic Mix — ${p.templates.length} templates`;
  }
};

const describeSize = (d: JobSizeDistribution): string => {
  switch (d.type) {
    case 'fixed': return `Fixed — ${d.cpu} CPU, ${d.memory} GB, ${d.gpu} GPU, ${fmtSec(d.duration)}`;
    case 'uniform':
      return `Uniform — CPU ${d.cpuRange[0]}–${d.cpuRange[1]}, Mem ${d.memoryRange[0]}–${d.memoryRange[1]} GB` +
        (d.gpuRange[1] > 0 ? `, GPU ${d.gpuRange[0]}–${d.gpuRange[1]}` : '') +
        `, Duration ${fmtSec(d.durationRange[0])}–${fmtSec(d.durationRange[1])}`;
    case 'pareto': return `Pareto (α=${d.alpha}) — min CPU ${d.cpuMin}, min Mem ${d.memoryMin} GB, min Duration ${fmtSec(d.durationMin)}`;
    case 'mixed': return `Mixed — ${d.small}% small, ${d.medium}% medium, ${d.large}% large`;
  }
};

// ── CSV Export ───────────────────────────────────────────────────────────────

const escCsv = (v: string | number): string => {
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

export const exportCSV = (result: BenchmarkSuiteResult, preset?: ScenarioPreset): void => {
  const scenarios = result.scenarios;
  const rows: string[][] = [];

  // Scenario details
  if (preset) {
    const wc = preset.workloadConfig;
    rows.push(['Scenario Details']);
    rows.push(['Name', preset.name]);
    rows.push(['Description', preset.description]);
    rows.push(['Phase', String(preset.phase)]);
    rows.push(['Duration', fmtSec(wc.durationSeconds)]);
    rows.push(['Arrival Pattern', describeArrival(wc.arrivalPattern)]);
    if (wc.arrivalPattern.type !== 'periodic_mix') {
      rows.push(['Size Distribution', describeSize(wc.sizeDistribution)]);
    }
    rows.push(['Seed', String(wc.seed)]);
    if (wc.arrivalPattern.type === 'periodic_mix') {
      rows.push([]);
      rows.push(['Job Templates']);
      rows.push(['Name', 'Org', 'CPU', 'Memory (GB)', 'GPU', 'Duration', 'Interval', 'Est. Count', 'User Priority', 'Tool Priority']);
      for (const t of wc.arrivalPattern.templates) {
        rows.push([
          t.name,
          t.orgId,
          String(vcpuFromCpuMillis(t.cpuMillis)),
          String(gbFromMemoryMiB(t.memoryMiB)),
          String(t.gpu),
          fmtSec(t.durationSeconds),
          `every ${fmtSec(t.intervalSeconds)}`,
          String(Math.floor(wc.durationSeconds / t.intervalSeconds)),
          String(t.userPriority),
          String(t.toolPriority),
        ]);
      }
    }
    rows.push([]);
  }

  // Header
  rows.push(['Metric', ...scenarios.map(s => s.scenarioName)]);

  // Overview metrics
  const metrics: Array<{ label: string; extract: (a: AggregatedMetrics) => string }> = [
    { label: 'Throughput (jobs/min)', extract: a => fmtNum(a.throughput.mean) },
    { label: 'Throughput CI', extract: a => ciStr(a.throughput) },
    { label: 'Mean Wait Time (s)', extract: a => fmtNum(a.meanWaitTime.mean) },
    { label: 'Mean Wait Time CI', extract: a => ciTimeStr(a.meanWaitTime) },
    { label: 'P50 Wait Time (s)', extract: a => fmtNum(a.p50WaitTime.mean) },
    { label: 'P50 Wait Time CI', extract: a => ciTimeStr(a.p50WaitTime) },
    { label: 'P95 Wait Time (s)', extract: a => fmtNum(a.p95WaitTime.mean) },
    { label: 'P95 Wait Time CI', extract: a => ciTimeStr(a.p95WaitTime) },
    { label: 'P99 Wait Time (s)', extract: a => fmtNum(a.p99WaitTime.mean) },
    { label: 'P99 Wait Time CI', extract: a => ciTimeStr(a.p99WaitTime) },
    { label: 'Max Wait Time (s)', extract: a => fmtNum(a.maxWaitTime.mean) },
    { label: 'Max Wait Time CI', extract: a => ciTimeStr(a.maxWaitTime) },
    { label: "Jain's Fairness Index", extract: a => fmtNum(a.jainsIndex.mean) },
    { label: 'Wait Time CoV', extract: a => fmtNum(a.coefficientOfVariation.mean) },
  ];

  for (const m of metrics) {
    rows.push([m.label, ...scenarios.map(s => m.extract(s.aggregated))]);
  }

  // Per-org metrics
  if (scenarios.length > 0) {
    const orgIds = Object.keys(scenarios[0].aggregated.orgMetrics);
    rows.push([]);
    rows.push(['Per-Org Metrics']);
    for (const orgId of orgIds) {
      rows.push([`${orgId} — Mean Wait (s)`, ...scenarios.map(s => fmtNum(s.aggregated.orgMetrics[orgId]?.meanWaitTime.mean ?? 0))]);
      rows.push([`${orgId} — Jobs Completed`, ...scenarios.map(s => fmtNum(s.aggregated.orgMetrics[orgId]?.jobsCompleted.mean ?? 0))]);
    }
  }

  // Statistical comparisons
  if (result.comparisons.length > 0) {
    rows.push([]);
    rows.push(['Statistical Comparisons (Paired t-test)']);
    rows.push(['Pair', 'Metric', 't-statistic', 'p-value', "Cohen's d", 'Effect', 'Significant', 'Winner']);
    for (const c of result.comparisons) {
      const pair = `${c.nameA} vs ${c.nameB}`;
      const compMetrics: Array<{ label: string; test: PairedTestResult; winner: string }> = [
        { label: 'Throughput', test: c.throughput, winner: c.winners['throughput'] },
        { label: 'Mean Wait Time', test: c.meanWaitTime, winner: c.winners['meanWaitTime'] },
        { label: 'P95 Wait Time', test: c.p95WaitTime, winner: c.winners['p95WaitTime'] },
        { label: "Jain's Fairness", test: c.jainsIndex, winner: c.winners['jainsIndex'] },
      ];
      for (const cm of compMetrics) {
        rows.push([
          pair, cm.label,
          fmtNum(cm.test.tStatistic, 3),
          cm.test.pValue < 0.001 ? '<0.001' : fmtNum(cm.test.pValue, 4),
          cm.test.cohensD >= 1e5 ? 'deterministic' : fmtNum(cm.test.cohensD),
          cm.test.effectLabel,
          cm.test.significant ? 'yes' : 'no',
          cm.winner,
        ]);
      }
    }
  }

  const csv = rows.map(r => r.map(escCsv).join(',')).join('\n');
  download(csv, `benchmark_${timestamp()}.csv`, 'text/csv;charset=utf-8');
};

// ── JSON Export ──────────────────────────────────────────────────────────────

export const exportJSON = (result: BenchmarkSuiteResult, preset?: ScenarioPreset): void => {
  // Strip rawMetrics to keep the file manageable — keep aggregated + comparisons
  const exportData: Record<string, unknown> = {
    name: result.name,
    exportedAt: new Date().toISOString(),
    wallClockMs: result.completedAt - result.startedAt,
    scenarios: result.scenarios.map(s => ({
      id: s.scenarioId,
      name: s.scenarioName,
      runs: s.aggregated.runs,
      aggregated: s.aggregated,
      runStats: s.runStats,
    })),
    comparisons: result.comparisons,
  };
  if (preset) {
    exportData.workloadScenario = {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      phase: preset.phase,
      config: preset.workloadConfig,
    };
  }
  const json = JSON.stringify(exportData, null, 2);
  download(json, `benchmark_${timestamp()}.json`, 'application/json');
};

// ── Markdown Export ──────────────────────────────────────────────────────────

export const exportMarkdown = (result: BenchmarkSuiteResult, preset?: ScenarioPreset): void => {
  const scenarios = result.scenarios;
  const lines: string[] = [];
  const wallSec = ((result.completedAt - result.startedAt) / 1000).toFixed(1);

  lines.push(`# CRMQ Benchmark Report`);
  lines.push('');
  lines.push(`**${result.name}**`);
  lines.push('');
  lines.push(`- Scenarios: ${scenarios.length}`);
  lines.push(`- Replications: ${scenarios[0]?.aggregated.runs ?? 0}`);
  lines.push(`- Wall-clock: ${wallSec}s`);
  lines.push(`- Exported: ${new Date().toISOString()}`);
  lines.push('');

  // Workload scenario details
  if (preset) {
    const wc = preset.workloadConfig;
    lines.push('## Workload Scenario');
    lines.push('');
    lines.push(`**${preset.name}** (Phase ${preset.phase})`);
    lines.push('');
    lines.push(`> ${preset.description}`);
    lines.push('');
    lines.push(`| Parameter | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Duration | ${fmtSec(wc.durationSeconds)} |`);
    lines.push(`| Arrival Pattern | ${describeArrival(wc.arrivalPattern)} |`);
    if (wc.arrivalPattern.type !== 'periodic_mix') {
      lines.push(`| Size Distribution | ${describeSize(wc.sizeDistribution)} |`);
    }
    lines.push(`| Seed | ${wc.seed} |`);
    lines.push('');

    if (wc.arrivalPattern.type === 'mmpp') {
      lines.push('### MMPP States');
      lines.push('');
      lines.push('| State | Rate (jobs/min) | Weight |');
      lines.push('| --- | --- | --- |');
      for (const s of wc.arrivalPattern.states) {
        lines.push(`| ${s.label} | ${s.lambdaPerMinute} | ${(s.weight * 100).toFixed(0)}% |`);
      }
      lines.push('');
      lines.push(`Transition interval: ${fmtSec(wc.arrivalPattern.transitionInterval)}`);
      lines.push('');
    }

    if (wc.arrivalPattern.type === 'periodic_mix') {
      lines.push('### Job Templates');
      lines.push('');
      lines.push('| Job Type | Org | CPU | Mem (GB) | GPU | Duration | Interval | Est. Count | User Prio | Tool Prio |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const t of wc.arrivalPattern.templates) {
        const line =
          `| ${t.name} | ${t.orgId} | ` +
          `${vcpuFromCpuMillis(t.cpuMillis)} | ` +
          `${gbFromMemoryMiB(t.memoryMiB)} | ${t.gpu} | ` +
          `${fmtSec(t.durationSeconds)} | ` +
          `every ${fmtSec(t.intervalSeconds)} | ` +
          `${Math.floor(wc.durationSeconds / t.intervalSeconds)} | ` +
          `${t.userPriority} | ${t.toolPriority} |`;
        lines.push(line);
      }
      lines.push('');

      // Per-org summary
      const orgSummary: Record<string, { jobs: number; totalCpu: number }> = {};
      for (const t of wc.arrivalPattern.templates) {
        const count = Math.floor(wc.durationSeconds / t.intervalSeconds);
        if (!orgSummary[t.orgId]) {
          orgSummary[t.orgId] = { jobs: 0, totalCpu: 0 };
        }
        orgSummary[t.orgId].jobs += count;
        orgSummary[t.orgId].totalCpu += count * vcpuFromCpuMillis(t.cpuMillis);
      }
      lines.push('### Per-Org Summary');
      lines.push('');
      lines.push('| Org | Total Jobs | Total CPU-units |');
      lines.push('| --- | --- | --- |');
      for (const [orgId, s] of Object.entries(orgSummary)) {
        lines.push(`| ${orgId} | ${s.jobs} | ${s.totalCpu.toLocaleString()} |`);
      }
      lines.push('');
    }
  }

  // Overview table
  lines.push('## Overview');
  lines.push('');

  const header = ['Metric', ...scenarios.map(s => s.scenarioName)];
  const sep = header.map(() => '---');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${sep.join(' | ')} |`);

  const overviewRows: Array<{ label: string; extract: (a: AggregatedMetrics) => string }> = [
    { label: 'Throughput (jobs/min)', extract: a => ciStr(a.throughput) },
    { label: 'Mean Wait Time', extract: a => ciTimeStr(a.meanWaitTime) },
    { label: 'P50 Wait Time', extract: a => ciTimeStr(a.p50WaitTime) },
    { label: 'P95 Wait Time', extract: a => ciTimeStr(a.p95WaitTime) },
    { label: 'P99 Wait Time', extract: a => ciTimeStr(a.p99WaitTime) },
    { label: 'Max Wait Time', extract: a => ciTimeStr(a.maxWaitTime) },
    { label: "Jain's Fairness Index", extract: a => ciStr(a.jainsIndex) },
    { label: 'Wait Time CoV', extract: a => ciStr(a.coefficientOfVariation) },
  ];

  for (const r of overviewRows) {
    lines.push(`| ${r.label} | ${scenarios.map(s => r.extract(s.aggregated)).join(' | ')} |`);
  }
  lines.push('');

  // Per-scenario details
  lines.push('## Per-Scenario Details');
  lines.push('');
  for (const s of scenarios) {
    const a = s.aggregated;
    lines.push(`### ${s.scenarioName}`);
    lines.push('');
    const avgDur = s.runStats.reduce((acc, r) => acc + r.simDuration, 0) / s.runStats.length;
    const avgWarmUp = s.runStats.reduce((acc, r) => acc + r.warmUpTime, 0) / s.runStats.length;
    const avgEvents = Math.round(s.runStats.reduce((acc, r) => acc + r.totalEvents, 0) / s.runStats.length);
    lines.push(`- Runs: ${a.runs}`);
    lines.push(`- Avg sim duration: ${fmtSec(avgDur)}`);
    lines.push(`- Avg warm-up: ${fmtSec(avgWarmUp)}`);
    lines.push(`- Avg events: ${avgEvents.toLocaleString()}`);
    lines.push('');

    // Utilization
    const poolTypes = Object.keys(a.utilization);
    if (poolTypes.length > 0) {
      lines.push('**Utilization (95% CI)**');
      lines.push('');
      for (const pt of poolTypes) {
        lines.push(`- ${pt}: CPU ${ciPctStr(a.utilization[pt].cpu)}, GPU ${ciPctStr(a.utilization[pt].gpu)}`);
      }
      lines.push('');
    }

    // Per-org
    const orgIds = Object.keys(a.orgMetrics);
    if (orgIds.length > 0) {
      lines.push('**Per-Org**');
      lines.push('');
      lines.push('| Org | Mean Wait | Jobs Completed |');
      lines.push('| --- | --- | --- |');
      for (const orgId of orgIds) {
        lines.push(`| ${orgId} | ${ciTimeStr(a.orgMetrics[orgId].meanWaitTime)} | ${ciStr(a.orgMetrics[orgId].jobsCompleted)} |`);
      }
      lines.push('');
    }
  }

  // Statistical comparisons
  if (result.comparisons.length > 0) {
    lines.push('## Statistical Comparisons');
    lines.push('');
    for (const c of result.comparisons) {
      lines.push(`### ${c.nameA} vs ${c.nameB}`);
      lines.push('');
      lines.push(`Paired t-test (n=${c.throughput.n})`);
      lines.push('');
      lines.push('| Metric | t | p-value | Effect | Winner |');
      lines.push('| --- | --- | --- | --- | --- |');

      const compMetrics: Array<{ label: string; test: PairedTestResult; winner: string }> = [
        { label: 'Throughput', test: c.throughput, winner: c.winners['throughput'] },
        { label: 'Mean Wait', test: c.meanWaitTime, winner: c.winners['meanWaitTime'] },
        { label: 'P95 Wait', test: c.p95WaitTime, winner: c.winners['p95WaitTime'] },
        { label: "Jain's FI", test: c.jainsIndex, winner: c.winners['jainsIndex'] },
      ];
      for (const cm of compMetrics) {
        const pStr = cm.test.pValue < 0.001 ? '<0.001' : fmtNum(cm.test.pValue, 4);
        const dStr = cm.test.cohensD >= 1e5 ? 'deterministic' : `${cm.test.effectLabel} (d=${fmtNum(cm.test.cohensD)})`;
        const sigStr = cm.test.significant ? '' : 'ns';
        lines.push(`| ${cm.label} | ${fmtNum(cm.test.tStatistic, 2)} | ${pStr} | ${sigStr || dStr} | ${cm.winner} |`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('*Generated by CRMQ Benchmark Simulator — Deep Origin*');

  const md = lines.join('\n');
  download(md, `benchmark_${timestamp()}.md`, 'text/markdown;charset=utf-8');
};
