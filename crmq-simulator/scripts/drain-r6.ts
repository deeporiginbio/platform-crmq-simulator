/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Drain-time probe for R6: let the DES run with Infinity TTL and a very
 * large maxSimTime cap, so that every submitted job eventually completes.
 *
 * Reports:
 *   - time-to-drain (wall clock in the sim when the last job completes)
 *   - completed / evicted totals (should be 100% completed)
 *   - throughput across the whole drain window
 */

import { SCENARIO_PRESETS, generateWorkload } from '../src/lib/benchmark/traffic';
import { runDES } from '../src/lib/benchmark/des-engine';
import { DEFAULT_CONFIG, DEFAULT_ORGS } from '../src/lib/scheduler';

const preset = SCENARIO_PRESETS.find(p => p.id === 'multi-pool-overload-pipelines');
if (!preset) throw new Error('R6 preset missing');

const workload = generateWorkload({
  ...preset.workloadConfig,
  orgs: DEFAULT_ORGS,
  ttlDefault: Number.POSITIVE_INFINITY,
});

const MAX = 60 * 86400; // 60 days of sim-time safety cap

const t0 = Date.now();
const res = runDES({
  config: DEFAULT_CONFIG,
  orgs: DEFAULT_ORGS,
  workload,
  maxSimTime: MAX,
});
const wallMs = Date.now() - t0;

let submitted = 0, completed = 0, evicted = 0;
let lastCompletion = 0;
const waits: number[] = [];

for (const ev of res.events) {
  submitted += 1;
  if (ev.evictedAt !== null) evicted += 1;
  if (ev.startedAt !== null && ev.completedAt !== null) {
    completed += 1;
    lastCompletion = Math.max(lastCompletion, ev.completedAt);
    waits.push(ev.startedAt - ev.enqueuedAt);
  }
}

const fmtDur = (s: number) => {
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(2)}d`;
};

const pct = (arr: number[], p: number) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
};

console.log(`\n═══ R6 drain probe — ${preset.name} ═══`);
console.log(`DES wall:              ${wallMs} ms`);
console.log(`Sim duration (ctx):    ${fmtDur(res.simDuration)}`);
console.log(`Last completion at:    ${fmtDur(lastCompletion)}  (= drain time)`);
console.log(`Arrival window:        ${fmtDur(preset.workloadConfig.durationSeconds)}`);
console.log(`Tail after arrivals:   ${fmtDur(Math.max(0, lastCompletion - preset.workloadConfig.durationSeconds))}`);
console.log(`Events processed:      ${res.totalEventsProcessed}`);
console.log(`Submitted / completed / evicted: ${submitted} / ${completed} / ${evicted}`);
console.log(`Overall throughput:    ${(completed / (lastCompletion / 60)).toFixed(2)} jobs/min`);
console.log(`Wait-time P50 / P95 / P99 / max: ${fmtDur(pct(waits, 50))} / ${fmtDur(pct(waits, 95))} / ${fmtDur(pct(waits, 99))} / ${fmtDur(Math.max(0, ...waits))}`);
