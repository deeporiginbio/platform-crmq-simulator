/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Simulation Store
 * =================
 * Zustand store that owns ALL simulation state and the tick engine.
 *
 * Key behaviors:
 * 1. Module-level singleton — survives React component unmounts (tab switches)
 * 2. Background interval — sim keeps running when you navigate away
 * 3. Wall-clock catch-up — when the browser tab is closed and reopened,
 *    the sim fast-forwards through the missed real time so it finishes
 *    on schedule (e.g. 10-min sim started at 01:37 still finishes at 01:47)
 * 4. Auto-persistence — debounced save to localStorage every 500ms
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  Job,
  RunningJob,
  CompletedJob,
  EvictedJob,
  LogEntry,
  OrgUsageMap,
  PredictionMap,
  LogType,
} from './types';
import {
  PRESET_JOBS,
  zeroPoolUsage,
  fmtTime,
  newJobId,
  resetJobIdCounter,
  completeJobs,
  evictExpired,
  runScheduler,
} from './scheduler';
import { predict } from './virtual-cluster';
import { useConfigStore } from './store';
import { loadSimState, persistSimState } from './sim-persistence';
import type { CRMQConfig, Org } from './types';
import { generateWorkload, SCENARIO_PRESETS } from './benchmark/traffic';

// ── Types ───────────────────────────────────────────────────────────────────

interface SimStore {
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
  predictions: PredictionMap;

  tick: (dt: number) => void;
  start: () => void;
  pause: () => void;
  toggleRunning: () => void;
  setSpeed: (speed: number) => void;
  reset: () => void;
  loadPreset: () => void;
  loadScenario: (scenarioId: string) => void;
  enqueue: (job: Omit<Job, 'id' | 'enqueuedAt' | 'skipCount'>) => void;
}

// ── Log ID counter ──────────────────────────────────────────────────────────

let _logId = 0;
const mkLog = (t: number, msg: string, type: LogType = 'info'): LogEntry => ({
  id: ++_logId,
  t,
  msg,
  type,
});

// ── Silent tick (for fast-forward — skips predictions & log limits) ─────────

interface TickState {
  simTime: number;
  queue: Job[];
  active: RunningJob[];
  completed: CompletedJob[];
  evicted: EvictedJob[];
  logs: LogEntry[];
  reservMode: boolean;
  reservTarget: string | null;
  orgUsage: OrgUsageMap;
}

/**
 * Run a single scheduler tick purely on data — no store writes.
 * Used for fast-forward catch-up where we need to run many ticks quickly.
 */
const silentTick = (
  st: TickState,
  dt: number,
  cfg: CRMQConfig,
  orgs: Org[],
): TickState => {
  const now = st.simTime + dt;

  // Silent logger — captures but doesn't cap during fast-forward
  const newLogs: LogEntry[] = [];
  const log = (t: number, msg: string, type: LogType = 'info') => {
    newLogs.push(mkLog(t, msg, type));
  };

  const comp = completeJobs(st.active, dt, now, st.orgUsage, cfg, log);
  const ttl = evictExpired(st.queue, now, log);
  const res = runScheduler(
    ttl.live, comp.stillRunning, comp.orgUsage,
    st.reservMode, st.reservTarget,
    now, cfg, orgs, log,
  );

  return {
    simTime: now,
    queue: res.queue as Job[],
    active: res.active,
    completed: [...comp.completed, ...st.completed].slice(0, 60),
    evicted: [...(ttl.evicted as EvictedJob[]), ...st.evicted].slice(0, 30),
    logs: [...newLogs, ...st.logs].slice(0, 150),
    orgUsage: res.orgUsage,
    reservMode: res.reservMode,
    reservTarget: res.reservTarget,
  };
};

// ── Restore & catch-up ──────────────────────────────────────────────────────

const restored = typeof window !== 'undefined' ? loadSimState() : null;
const defaultOrgUsage = (): OrgUsageMap => {
  const { cfg, orgs } = useConfigStore.getState();
  return Object.fromEntries(orgs.map((o) => [o.id, zeroPoolUsage(cfg)]));
};

/**
 * Compute the catch-up state: if the sim was running when saved, calculate
 * how many real seconds passed and fast-forward through that many ticks.
 *
 * The tick interval is 200ms real-time, each tick advances by `speed` sim-seconds.
 * So: missedTicks = elapsedRealSeconds / 0.2
 *     totalSimAdvance = missedTicks × speed
 *
 * We cap at 50,000 ticks (~2.7 hours at ×1) to prevent browser freezing.
 */
const computeCatchUp = (): TickState & { running: boolean; speed: number } | null => {
  if (!restored || !restored.running || !restored.savedAt) return null;

  const elapsedMs = Date.now() - restored.savedAt;
  if (elapsedMs < 500) return null; // less than one tick interval — nothing to catch up

  const elapsedRealSec = elapsedMs / 1000;
  const tickIntervalSec = 0.2;
  const missedTicks = Math.floor(elapsedRealSec / tickIntervalSec);
  const cappedTicks = Math.min(missedTicks, 50_000);

  if (cappedTicks === 0) return null;

  const { cfg, orgs } = useConfigStore.getState();
  const speed = restored.speed;

  let state: TickState = {
    simTime: restored.simTime,
    queue: restored.queue,
    active: restored.active,
    completed: restored.completed,
    evicted: restored.evicted,
    logs: restored.logs,
    reservMode: restored.reservMode,
    reservTarget: restored.reservTarget,
    orgUsage: restored.orgUsage,
  };

  // Fast-forward all missed ticks
  for (let i = 0; i < cappedTicks; i++) {
    state = silentTick(state, speed, cfg, orgs);

    // If queue and active are both empty, simulation is effectively done — stop early
    if (state.queue.length === 0 && state.active.length === 0) {
      return { ...state, running: false, speed };
    }
  }

  // If we capped and there's still work, keep running
  // If simulation naturally ended during catch-up, running was set to false above
  return { ...state, running: true, speed };
};

const catchUp = computeCatchUp();

// Determine initial state: catch-up result > restored snapshot > defaults
const initial = {
  simTime: catchUp?.simTime ?? restored?.simTime ?? 0,
  running: catchUp?.running ?? restored?.running ?? false,
  speed: catchUp?.speed ?? restored?.speed ?? 1,
  queue: catchUp?.queue ?? restored?.queue ?? [],
  active: catchUp?.active ?? restored?.active ?? [],
  completed: catchUp?.completed ?? restored?.completed ?? [],
  evicted: catchUp?.evicted ?? restored?.evicted ?? [],
  logs: catchUp?.logs ?? restored?.logs ?? [],
  reservMode: catchUp?.reservMode ?? restored?.reservMode ?? false,
  reservTarget: catchUp?.reservTarget ?? restored?.reservTarget ?? null,
  orgUsage: catchUp?.orgUsage ?? restored?.orgUsage ?? defaultOrgUsage(),
};

// ── Store ───────────────────────────────────────────────────────────────────

export const useSimStore = create<SimStore>()(
  subscribeWithSelector((set, get) => ({
    ...initial,
    predictions: {},

    tick: (dt: number) => {
      const st = get();
      const { cfg, orgs } = useConfigStore.getState();
      const now = st.simTime + dt;

      const newLogs: LogEntry[] = [];
      const log = (t: number, msg: string, type: LogType = 'info') => {
        newLogs.push(mkLog(t, msg, type));
      };

      const comp = completeJobs(st.active, dt, now, st.orgUsage, cfg, log);
      const ttl = evictExpired(st.queue, now, log);
      const res = runScheduler(
        ttl.live, comp.stillRunning, comp.orgUsage,
        st.reservMode, st.reservTarget,
        now, cfg, orgs, log,
      );

      const newQueue = res.queue as Job[];
      let preds: PredictionMap = {};
      if (newQueue.length > 0) {
        preds = predict(newQueue, res.active, res.orgUsage, now, cfg, orgs);
      }

      set({
        simTime: now,
        queue: newQueue,
        active: res.active,
        completed: [...comp.completed, ...st.completed].slice(0, 60),
        evicted: [...(ttl.evicted as EvictedJob[]), ...st.evicted].slice(0, 30),
        logs: [...newLogs, ...st.logs].slice(0, 150),
        orgUsage: res.orgUsage,
        reservMode: res.reservMode,
        reservTarget: res.reservTarget,
        predictions: preds,
      });
    },

    start: () => set({ running: true }),
    pause: () => set({ running: false }),
    toggleRunning: () => set((s) => ({ running: !s.running })),
    setSpeed: (speed) => set({ speed }),

    reset: () => {
      resetJobIdCounter();
      _logId = 0;
      persistSimState(null);
      set({
        simTime: 0,
        running: false,
        speed: 1,
        queue: [],
        active: [],
        completed: [],
        evicted: [],
        logs: [],
        reservMode: false,
        reservTarget: null,
        orgUsage: defaultOrgUsage(),
        predictions: {},
      });
    },

    loadPreset: () => {
      const st = get();
      const { cfg } = useConfigStore.getState();
      const jobs: Job[] = PRESET_JOBS.map((j, i) => ({
        ...j,
        id: newJobId(),
        enqueuedAt: st.simTime + i * 3,
        skipCount: 0,
        ttl: j.ttl ?? cfg.ttlDefault,
      }));
      const log = mkLog(st.simTime, `Loaded ${jobs.length} preset jobs into queue`, 'info');
      set({
        queue: [...st.queue, ...jobs],
        logs: [log, ...st.logs].slice(0, 150),
      });
    },

    loadScenario: (scenarioId: string) => {
      const preset = SCENARIO_PRESETS.find(s => s.id === scenarioId);
      if (!preset) return;

      const st = get();
      const { cfg, orgs } = useConfigStore.getState();

      // Generate workload using the benchmark traffic generator
      const generated = generateWorkload({
        ...preset.workloadConfig,
        orgs,
        ttlDefault: cfg.ttlDefault,
      });

      // Convert GeneratedJob[] to Job[] with proper IDs and adjusted arrival times
      // Arrival times are relative to current simTime
      const jobs: Job[] = generated.map((gj) => ({
        id: newJobId(),
        name: gj.name,
        orgId: gj.orgId,
        userPriority: gj.userPriority,
        toolPriority: gj.toolPriority,
        resources: gj.resources,
        estimatedDuration: gj.estimatedDuration,
        ttl: gj.ttl,
        enqueuedAt: st.simTime + gj.arrivalTime,
        skipCount: 0,
      }));

      const log = mkLog(
        st.simTime,
        `SCENARIO | Loaded "${preset.name}" — ${jobs.length} jobs over ${Math.round(preset.workloadConfig.durationSeconds / 60)}min`,
        'info',
      );

      set({
        queue: [...st.queue, ...jobs],
        logs: [log, ...st.logs].slice(0, 150),
      });
    },

    enqueue: (job) => {
      const st = get();
      const j: Job = {
        ...job,
        id: newJobId(),
        enqueuedAt: st.simTime,
        skipCount: 0,
      };
      const log = mkLog(
        st.simTime,
        `ENQUEUE | ${j.name} [${j.id}] — org=${j.orgId}, CPU:${j.resources.cpu} MEM:${j.resources.memory}GB GPU:${j.resources.gpu}, est=${fmtTime(j.estimatedDuration)}`,
        'info',
      );
      set({
        queue: [...st.queue, j],
        logs: [log, ...st.logs].slice(0, 150),
      });
    },
  })),
);

// ── Background Tick Engine ──────────────────────────────────────────────────

let _intervalId: ReturnType<typeof setInterval> | null = null;

const syncInterval = () => {
  const { running, speed, tick } = useSimStore.getState();

  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }

  if (running) {
    _intervalId = setInterval(() => tick(speed), 200);
  }
};

useSimStore.subscribe(
  (s) => ({ running: s.running, speed: s.speed }),
  syncInterval,
  { equalityFn: (a, b) => a.running === b.running && a.speed === b.speed },
);

// Kick-start immediately if restored as running (after catch-up)
syncInterval();

// ── Auto-Persist (debounced) ────────────────────────────────────────────────

/**
 * Save helper — snapshots the current store state to localStorage.
 */
const saveNow = () => {
  const s = useSimStore.getState();
  persistSimState({
    simTime: s.simTime,
    running: s.running,
    speed: s.speed,
    queue: s.queue,
    active: s.active,
    completed: s.completed,
    evicted: s.evicted,
    logs: s.logs,
    reservMode: s.reservMode,
    reservTarget: s.reservTarget,
    orgUsage: s.orgUsage,
    savedAt: Date.now(),
  });
};

// Periodic save every 2 seconds while running.
// The debounced approach can't fire during active ticking (200ms < 500ms debounce),
// and beforeunload doesn't fire reliably in all browsers/scenarios.
// This ensures we always have a recent snapshot with `running: true` + `savedAt`.
if (typeof window !== 'undefined') {
  setInterval(() => {
    const { running } = useSimStore.getState();
    if (running) saveNow();
  }, 2000);
}

// Also save when simulation stops (running changes to false) or on tick when paused
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

useSimStore.subscribe(
  (s) => ({
    simTime: s.simTime,
    running: s.running,
    speed: s.speed,
    queue: s.queue,
    active: s.active,
    completed: s.completed,
    evicted: s.evicted,
    logs: s.logs,
    reservMode: s.reservMode,
    reservTarget: s.reservTarget,
    orgUsage: s.orgUsage,
  }),
  (snapshot) => {
    // When not running, debounce normally (manual ticks, resets, etc.)
    if (!snapshot.running) {
      if (_saveTimer) clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => persistSimState({
        ...snapshot,
        savedAt: Date.now(),
      }), 300);
    }
    // When running, the periodic interval handles it
  },
);

// Immediate save on tab close (belt and suspenders)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', saveNow);
  // Also handle mobile/visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}
