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
import { useConfigStore } from './store';
import { loadSimState, persistSimState } from './sim-persistence';
import type { CRMQConfig, Org } from './types';
import { jobPools, jobResInPool, getPoolMeta, routeSingleResource } from './types';
import { gbFromMemoryMiB, vcpuFromCpuMillis } from './units';
import { generateWorkload, SCENARIO_PRESETS } from './benchmark/traffic';
import {
  stripConfig,
} from './workers/config-serde';
import type { PredictRequest, PredictResponse } from './workers/prediction.worker';

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

// ── Prediction Worker ───────────────────────────────────────────────────────

let _predWorker: Worker | null = null;
let _predReqId = 0;
/** ID of the latest request we sent — ignore stale results */
let _latestPredId = 0;
/** Whether a prediction is currently in flight */
let _predInFlight = false;
/** Queued request to send once the current one completes */
let _pendingPredInput: PredictRequest | null = null;
/** Counter for skipping predictions at high queue sizes */
let _predSkipCounter = 0;

const getPredWorker = (): Worker | null => {
  if (typeof window === 'undefined') return null;
  if (!_predWorker) {
    try {
      _predWorker = new Worker(
        new URL(
          './workers/prediction.worker.ts',
          import.meta.url,
        ),
      );
      _predWorker.onmessage = (
        e: MessageEvent<PredictResponse>,
      ) => {
        const msg = e.data;
        if (msg.type !== 'result') return;
        _predInFlight = false;

        // Only apply if this is the latest request
        if (msg.id === _latestPredId) {
          useSimStore.setState({
            predictions: msg.predictions,
          });
        }

        // If a newer request was queued, send it now
        if (_pendingPredInput) {
          const pending = _pendingPredInput;
          _pendingPredInput = null;
          sendPrediction(pending);
        }
      };
    } catch {
      // Worker creation failed — predictions will
      // be empty (graceful degradation)
      return null;
    }
  }
  return _predWorker;
};

const sendPrediction = (req: PredictRequest) => {
  const w = getPredWorker();
  if (!w) return;
  _predInFlight = true;
  _latestPredId = req.id;
  w.postMessage(req);
};

/**
 * Request an async prediction from the worker.
 * If a prediction is already in flight, queues the
 * latest input and sends it when the worker is free.
 */
const requestPrediction = (
  queue: Job[],
  active: RunningJob[],
  orgUsage: OrgUsageMap,
  currentTime: number,
  cfg: CRMQConfig,
  orgs: Org[],
) => {
  const req: PredictRequest = {
    type: 'predict',
    id: ++_predReqId,
    queue,
    active,
    orgUsage,
    currentTime,
    config: stripConfig(cfg),
    orgs,
  };

  if (_predInFlight) {
    // Overwrite any previously queued request —
    // only the latest state matters
    _pendingPredInput = req;
  } else {
    sendPrediction(req);
  }
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
      const log = (
        t: number,
        msg: string,
        type: LogType = 'info',
      ) => {
        newLogs.push(mkLog(t, msg, type));
      };

      const comp = completeJobs(
        st.active, dt, now, st.orgUsage, cfg, log,
      );
      const ttl = evictExpired(st.queue, now, log);
      const res = runScheduler(
        ttl.live, comp.stillRunning, comp.orgUsage,
        st.reservMode, st.reservTarget,
        now, cfg, orgs, log,
      );

      const newQueue = res.queue as Job[];

      // Update store immediately (no blocking)
      set({
        simTime: now,
        queue: newQueue,
        active: res.active,
        completed: [
          ...comp.completed,
          ...st.completed,
        ].slice(0, 60),
        evicted: [
          ...(ttl.evicted as EvictedJob[]),
          ...st.evicted,
        ].slice(0, 30),
        logs: [...newLogs, ...st.logs].slice(0, 150),
        orgUsage: res.orgUsage,
        reservMode: res.reservMode,
        reservTarget: res.reservTarget,
      });

      // Fire predictions async via worker.
      // Skip when queue is very large — the worker
      // can't keep up and results would be stale.
      if (newQueue.length === 0) {
        set({ predictions: {} });
      } else if (newQueue.length <= 200) {
        requestPrediction(
          newQueue,
          res.active,
          res.orgUsage,
          now,
          cfg,
          orgs,
        );
      } else {
        // For large queues, only predict every
        // ~5 ticks (based on simTime modulo).
        // This keeps predictions available but
        // avoids saturating the worker.
        _predSkipCounter++;
        if (_predSkipCounter >= 5) {
          _predSkipCounter = 0;
          requestPrediction(
            newQueue,
            res.active,
            res.orgUsage,
            now,
            cfg,
            orgs,
          );
        }
      }
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

      // Convert GeneratedJob[] to Job[] with proper IDs and adjusted arrival times.
      // Traffic generator emits single-pool Resources; route to the correct pool
      // via config-defined routeWhen predicates, then wrap as ResourcesByType.
      // Arrival times are relative to current simTime.
      const jobs: Job[] = generated.map((gj) => {
        const routedPool = routeSingleResource(gj.resources, cfg);
        return {
          id: newJobId(),
          name: gj.name,
          orgId: gj.orgId,
          userPriority: gj.userPriority,
          toolPriority: gj.toolPriority,
          resources: { [routedPool]: { ...gj.resources } },
          estimatedDuration: gj.estimatedDuration,
          ttl: gj.ttl,
          enqueuedAt: st.simTime + gj.arrivalTime,
          skipCount: 0,
        };
      });

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
      const cfg = useConfigStore.getState().cfg;
      const j: Job = {
        ...job,
        id: newJobId(),
        enqueuedAt: st.simTime,
        skipCount: 0,
      };
      // Log in UI units (vCPU + GB) — model uses cpuMillis + memoryMiB.
      const pools = jobPools(j);
      const perPool = pools
        .map((pt) => {
          const slice = jobResInPool(j, pt);
          const meta = getPoolMeta(cfg, pt);
          const parts: string[] = [];
          if (slice.cpuMillis > 0) parts.push(`CPU:${vcpuFromCpuMillis(slice.cpuMillis)}`);
          if (slice.memoryMiB > 0) parts.push(`MEM:${gbFromMemoryMiB(slice.memoryMiB)}GB`);
          if (slice.gpu > 0) parts.push(`GPU:${slice.gpu}`);
          const body = parts.join(' ');
          return pools.length > 1 ? `${meta.shortLabel}:{${body}}` : body;
        })
        .join(' ');
      const log = mkLog(
        st.simTime,
        `ENQUEUE | ${j.name} [${j.id}] — org=${j.orgId}, ${perPool}, est=${fmtTime(j.estimatedDuration)}`,
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

/**
 * Adaptive tick interval — slows down when the queue
 * is large to keep the UI responsive.
 *   ≤ 100 jobs → 200ms (5 fps)
 *   ≤ 300 jobs → 400ms
 *   ≤ 600 jobs → 600ms
 *   > 600 jobs → 1000ms (1 fps)
 */
const getTickInterval = (): number => {
  const qLen =
    useSimStore.getState().queue.length;
  if (qLen <= 100) return 200;
  if (qLen <= 300) return 400;
  if (qLen <= 600) return 600;
  return 1000;
};

const syncInterval = () => {
  const { running, speed, tick } =
    useSimStore.getState();

  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }

  if (running) {
    const ms = getTickInterval();
    _intervalId = setInterval(
      () => tick(speed),
      ms,
    );
  }
};

/**
 * Bucket the queue length so we only re-sync
 * the interval when crossing a threshold.
 */
const queueBucket = (len: number): number => {
  if (len <= 100) return 0;
  if (len <= 300) return 1;
  if (len <= 600) return 2;
  return 3;
};

useSimStore.subscribe(
  (s) => ({
    running: s.running,
    speed: s.speed,
    qBucket: queueBucket(s.queue.length),
  }),
  syncInterval,
  {
    equalityFn: (a, b) =>
      a.running === b.running &&
      a.speed === b.speed &&
      a.qBucket === b.qBucket,
  },
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
