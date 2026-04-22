/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Headless benchmark runner for the R6 multi-pool heavy-hybrid scenario.
 *
 * Runs R6 against the DES engine, aggregates the resulting JobEvent stream,
 * and prints a compact metrics summary (throughput, wait-time percentiles,
 * fairness, per-org and per-template dispatch + time-to-start, TTL evictions).
 *
 * Run with:   npx tsx scripts/run-multipool-bench.ts [scenario-id]
 *   default scenario: R6 (multi-pool-overload-pipelines)
 *   e.g.   npx tsx scripts/run-multipool-bench.ts multi-pool-overload-pipelines
 */

import { SCENARIO_PRESETS, generateWorkload } from '../src/lib/benchmark/traffic';
import { runDES } from '../src/lib/benchmark/des-engine';
import { computeMetrics } from '../src/lib/benchmark/metrics';
import { DEFAULT_CONFIG, DEFAULT_ORGS } from '../src/lib/scheduler';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '../src/lib/units';

const argId = process.argv[2];

// TTL policy per scenario: no wait-cap anywhere. R6 sees overload pressure
// via deep queues and long tails; evictions are not part of the target
// behaviour for this preset (per design: admission-only backpressure).
const TTL_BY_SCENARIO: Record<string, number> = {
  'multi-pool-overload-pipelines': Number.POSITIVE_INFINITY,
};

const scenarios = argId
  ? SCENARIO_PRESETS.filter(p => p.id === argId)
  : SCENARIO_PRESETS.filter(p => p.id in TTL_BY_SCENARIO);

if (scenarios.length === 0) {
  throw new Error(`No scenario matched id=${argId ?? '<default set>'}`);
}

const pct = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
};
const fmt = (n: number, d = 1): string => Number.isFinite(n) ? n.toFixed(d) : String(n);
const secs = (n: number): string => n < 60 ? `${n.toFixed(1)}s` : `${(n / 60).toFixed(1)}m`;

console.log(`\n── Cluster ──`);
for (const pool of DEFAULT_CONFIG.cluster.pools) {
  console.log(
    `  ${pool.type.padEnd(11)} `
    + `${vcpuFromCpuMillis(pool.total.cpuMillis)} vCPU / `
    + `${gbFromMemoryMiB(pool.total.memoryMiB)} GB / `
    + `${pool.total.gpu} GPU`
  );
}

for (const preset of scenarios) {
  const ttl = TTL_BY_SCENARIO[preset.id] ?? Number.POSITIVE_INFINITY;
  const workload = generateWorkload({
    ...preset.workloadConfig,
    orgs: DEFAULT_ORGS,
    ttlDefault: ttl,
  });

  const t0 = Date.now();
  const desResult = runDES({
    config: DEFAULT_CONFIG,
    orgs: DEFAULT_ORGS,
    workload,
  });
  const wallMs = Date.now() - t0;

  const metrics = computeMetrics(
    desResult.events,
    desResult.utilSamples,
    DEFAULT_CONFIG,
    DEFAULT_ORGS,
    desResult.simDuration,
  );

  const byOrg: Record<string, { submitted: number; completed: number; evicted: number }> = {};
  const byTemplate: Record<string, {
    submitted: number; completed: number; evicted: number;
    waits: number[]; multiPool: boolean;
  }> = {};

  for (const ev of desResult.events) {
    const tmpl = ev.jobName.replace(/\s*#\d+$/, '');
    byTemplate[tmpl] ??= { submitted: 0, completed: 0, evicted: 0, waits: [], multiPool: false };
    byTemplate[tmpl].submitted += 1;
    byOrg[ev.orgId] ??= { submitted: 0, completed: 0, evicted: 0 };
    byOrg[ev.orgId].submitted += 1;

    if (ev.evictedAt !== null) {
      byTemplate[tmpl].evicted += 1;
      byOrg[ev.orgId].evicted += 1;
    }
    if (ev.startedAt !== null && ev.completedAt !== null) {
      byTemplate[tmpl].completed += 1;
      byOrg[ev.orgId].completed += 1;
      byTemplate[tmpl].waits.push(ev.startedAt - ev.enqueuedAt);
    }
  }

  for (const j of workload) {
    const tmpl = j.name.replace(/\s*#\d+$/, '');
    const slot = byTemplate[tmpl];
    if (!slot) continue;
    if (j.resourcesByType && Object.keys(j.resourcesByType).length > 1) {
      slot.multiPool = true;
    }
  }

  console.log(`\n\n═══ ${preset.name} (id=${preset.id}) ═══`);
  console.log(`TTL:                   ${Number.isFinite(ttl) ? secs(ttl) : 'Infinity'}`);
  console.log(`DES wall time:         ${wallMs} ms`);
  console.log(`Sim duration:          ${secs(desResult.simDuration)} (${desResult.simDuration.toFixed(0)}s)`);
  console.log(`Events processed:      ${desResult.totalEventsProcessed}`);
  console.log(`Jobs submitted:        ${metrics.totalJobs}`);
  console.log(`Jobs completed:        ${metrics.jobsCompleted} (${fmt(100 * metrics.jobsCompleted / metrics.totalJobs, 1)}%)`);
  console.log(`Jobs evicted:          ${metrics.jobsEvicted} (${fmt(100 * metrics.evictionRate, 2)}%)`);
  console.log(`Throughput:            ${fmt(metrics.throughput, 2)} jobs/min`);

  console.log(`\n── Wait-time latency (completed jobs only) ──`);
  console.log(`  mean:   ${secs(metrics.meanWaitTime)}`);
  console.log(`  P50:    ${secs(metrics.p50WaitTime)}`);
  console.log(`  P95:    ${secs(metrics.p95WaitTime)}`);
  console.log(`  P99:    ${secs(metrics.p99WaitTime)}`);
  console.log(`  max:    ${secs(metrics.maxWaitTime)}`);

  console.log(`\n── Fairness ──`);
  console.log(`  Jain's index:          ${fmt(metrics.jainsIndex, 3)}`);
  console.log(`  Coeff. of variation:   ${fmt(metrics.coefficientOfVariation, 3)}`);
  console.log(`  max/median wait:       ${fmt(metrics.maxMedianWaitRatio, 2)}`);

  console.log(`\n── Utilization (time-weighted) ──`);
  for (const [pool, util] of Object.entries(metrics.utilization)) {
    console.log(`  ${pool.padEnd(11)} cpu ${fmt(100 * util.cpu, 1)}%  mem ${fmt(100 * util.memory, 1)}%  gpu ${fmt(100 * util.gpu, 1)}%`);
  }
  console.log(`  Fragmentation:`);
  for (const [pool, frag] of Object.entries(metrics.resourceFragmentation)) {
    console.log(`    ${pool.padEnd(11)} ${fmt(100 * frag, 1)}% wasted`);
  }

  console.log(`\n── Per-org dispatch ──`);
  for (const [orgId, stats] of Object.entries(byOrg)) {
    const m = metrics.orgMetrics[orgId];
    console.log(
      `  ${orgId.padEnd(10)} submitted ${String(stats.submitted).padStart(3)}  `
      + `completed ${String(stats.completed).padStart(3)} (${fmt(100 * stats.completed / stats.submitted, 1)}%)  `
      + `evicted ${String(stats.evicted).padStart(3)}  `
      + `wait-mean ${secs(m?.meanWaitTime ?? 0)}  p95 ${secs(m?.p95WaitTime ?? 0)}  `
      + `dom-share ${fmt((m?.dominantShare ?? 0) * 100, 1)}%`
    );
  }

  console.log(`\n── Per-template dispatch + wait ──`);
  const templates = Object.entries(byTemplate).sort((a, b) => b[1].submitted - a[1].submitted);
  for (const [tmpl, stats] of templates) {
    const tag = stats.multiPool ? 'MP' : '— ';
    const waitMean = stats.waits.reduce((a, b) => a + b, 0) / (stats.waits.length || 1);
    console.log(
      `  [${tag}] ${tmpl.padEnd(20)} sub ${String(stats.submitted).padStart(3)}  `
      + `done ${String(stats.completed).padStart(3)}  `
      + `evict ${String(stats.evicted).padStart(3)}  `
      + `ttS mean ${secs(waitMean)}  P95 ${secs(pct(stats.waits, 95))}  max ${secs(Math.max(0, ...stats.waits))}`
    );
  }
}

console.log('');
