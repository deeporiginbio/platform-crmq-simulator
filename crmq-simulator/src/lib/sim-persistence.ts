/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Simulation State Persistence
 * ==============================
 * Auto-saves and restores the full simulation state (queue, active jobs,
 * completed, evicted, logs, timers, etc.) to localStorage so the sim
 * survives page refreshes and tab switches.
 *
 * Separate from config persistence — config lives in the Zustand store
 * and has its own auto-save in store.ts.
 */

import type { Job, RunningJob, CompletedJob, EvictedJob, LogEntry, OrgUsageMap } from './types';

const SIM_KEY = 'crmq:sim-state';

export interface SimSnapshot {
  simTime: number;
  running: boolean;
  speed: number;
  queue: Job[];
  active: RunningJob[];
  completed: CompletedJob[];
  evicted: EvictedJob[];
  logs: LogEntry[];
  reservMode: boolean;
  reservTarget: string | null;
  orgUsage: OrgUsageMap;
  /** Wall-clock epoch ms when this snapshot was saved. Used to compute
   *  elapsed real time for catch-up on restore. */
  savedAt: number;
}

/**
 * Persist simulation state to localStorage.
 * Pass `null` to clear (on reset).
 */
export const persistSimState = (state: SimSnapshot | null) => {
  try {
    if (state === null) {
      localStorage.removeItem(SIM_KEY);
    } else {
      localStorage.setItem(SIM_KEY, JSON.stringify(state));
    }
  } catch {
    // localStorage full or unavailable — silently ignore
  }
};

/**
 * Detect pre-unit-rename simulation snapshots (`cpu`/`memory` on Resources).
 * Post-rename snapshots always emit `cpuMillis` / `memoryMiB` somewhere
 * (jobs' resources, orgUsage, etc.). Legacy snapshots have `"cpu":<num>`
 * or `"memory":<num>` and no `cpuMillis` / `memoryMiB` markers.
 */
const isLegacySimSnapshot = (raw: string): boolean => {
  if (raw.includes('"cpuMillis"') || raw.includes('"memoryMiB"')) return false;
  return /"(?:cpu|memory)"\s*:\s*-?\d/.test(raw);
};

/**
 * Load simulation state from localStorage.
 * Returns null if nothing saved, parse fails, or the blob is stale
 * (pre unit-rename). On stale data the key is cleared.
 */
export const loadSimState = (): SimSnapshot | null => {
  try {
    const raw = localStorage.getItem(SIM_KEY);
    if (!raw) return null;
    if (isLegacySimSnapshot(raw)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[crmq] Dropping legacy simulation snapshot at "${SIM_KEY}" ` +
        `(pre unit-rename; no cpuMillis/memoryMiB keys).`,
      );
      localStorage.removeItem(SIM_KEY);
      return null;
    }
    const parsed = JSON.parse(raw) as SimSnapshot;
    // Basic sanity check
    if (typeof parsed.simTime !== 'number' || !Array.isArray(parsed.queue)) {
      // eslint-disable-next-line no-console
      console.warn(`[crmq] Malformed sim snapshot at "${SIM_KEY}"; clearing.`);
      try { localStorage.removeItem(SIM_KEY); } catch { /* ignore */ }
      return null;
    }
    return parsed;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[crmq] Failed to parse sim snapshot at "${SIM_KEY}"; clearing.`);
    try { localStorage.removeItem(SIM_KEY); } catch { /* ignore */ }
    return null;
  }
};
