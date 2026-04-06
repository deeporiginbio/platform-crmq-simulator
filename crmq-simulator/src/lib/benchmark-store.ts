/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Benchmark Store
 * ================
 * Zustand store that manages benchmark execution state.
 * Runs benchmarks in the main thread (Web Worker can be added later).
 */

import { create } from 'zustand';
import type { CRMQConfig, Org } from './types';
import { DEFAULT_CONFIG, DEFAULT_ORGS } from './scheduler';
import {
  runBenchmarkSuite,
  getFormulas,
  SCENARIO_PRESETS,
} from './benchmark';
import type {
  BenchmarkSuiteConfig,
  BenchmarkSuiteResult,
  ScenarioPreset,
  ScoringFormula,
  ArrivalPattern,
  JobSizeDistribution,
} from './benchmark';

// ── Types ───────────────────────────────────────────────────────────────────

export type BenchmarkPhase = 'idle' | 'configuring' | 'running' | 'done' | 'error';

export interface FormulaSelection {
  id: string;
  name: string;
  /** Optional config overrides for this formula */
  configOverrides?: Partial<CRMQConfig>;
}

interface BenchmarkStore {
  // ── State ──────────────────────────────────────────────────
  phase: BenchmarkPhase;
  /** Selected scenario preset */
  scenarioId: string;
  /** Selected formula IDs to compare */
  selectedFormulas: string[];
  /** Number of replications */
  replications: number;
  /** Progress 0–100 */
  progress: number;
  progressLabel: string;
  /** The results after a completed run */
  result: BenchmarkSuiteResult | null;
  /** Error message if something went wrong */
  error: string | null;
  /** AbortController for the current run (internal) */
  _abortCtrl: AbortController | null;

  // ── Actions ────────────────────────────────────────────────
  setScenario: (id: string) => void;
  toggleFormula: (id: string) => void;
  setReplications: (n: number) => void;
  run: (config: CRMQConfig, orgs: Org[]) => void;
  cancel: () => void;
  reset: () => void;
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useBenchmarkStore = create<BenchmarkStore>((set, get) => ({
  phase: 'idle',
  scenarioId: 'steady-state',
  selectedFormulas: ['current_weighted', 'normalized_weighted_sum'],
  replications: 30,
  progress: 0,
  progressLabel: '',
  result: null,
  error: null,
  _abortCtrl: null,

  setScenario: (id) => set({ scenarioId: id }),

  toggleFormula: (id) => {
    const current = get().selectedFormulas;
    if (current.includes(id)) {
      if (current.length <= 1) return; // must keep at least 1
      set({ selectedFormulas: current.filter(f => f !== id) });
    } else {
      set({ selectedFormulas: [...current, id] });
    }
  },

  setReplications: (n) => set({ replications: Math.max(1, Math.min(200, n)) }),

  run: (config, orgs) => {
    const { scenarioId, selectedFormulas, replications } = get();
    const preset = SCENARIO_PRESETS.find(s => s.id === scenarioId);
    if (!preset) {
      set({ phase: 'error', error: `Scenario "${scenarioId}" not found` });
      return;
    }

    const formulas = getFormulas();

    // Build scenario configs — one per selected formula
    const scenarios = selectedFormulas.map(fid => {
      const formula = formulas.find(f => f.id === fid);
      return {
        id: fid,
        name: formula?.name ?? fid,
        config: { ...config, formulaType: (fid === 'current_weighted' ? config.formulaType : undefined) as CRMQConfig['formulaType'] },
        orgs,
        formulaId: fid,
      };
    });

    const suiteConfig: BenchmarkSuiteConfig = {
      name: `${preset.name} — ${selectedFormulas.length} formulas × ${replications} runs`,
      scenarios,
      workload: {
        durationSeconds: preset.workloadConfig.durationSeconds,
        arrivalPattern: preset.workloadConfig.arrivalPattern,
        sizeDistribution: preset.workloadConfig.sizeDistribution,
        ttlDefault: config.ttlDefault,
      },
      replications,
      baseSeed: preset.workloadConfig.seed,
      // Fixed warm-up at 10% of workload duration.
      // Auto-detection (sliding-window CV) is unreliable: it can report steady-state
      // during the drain-down phase after arrivals stop, pushing warm-up past the
      // entire arrival window and filtering out all data. A fixed 10% is robust
      // and sufficient to skip the initial cluster fill-up transient.
      warmUp: { type: 'fixed', seconds: Math.round(preset.workloadConfig.durationSeconds * 0.10) },
    };

    const abortCtrl = new AbortController();
    set({ phase: 'running', progress: 0, progressLabel: 'Starting...', error: null, result: null, _abortCtrl: abortCtrl });

    // Run async — runBenchmarkSuite yields to the browser between DES runs
    (async () => {
      try {
        const result = await runBenchmarkSuite(suiteConfig, (p) => {
          set({
            progress: p.pct,
            progressLabel: `${p.phase} — scenario ${p.scenarioIndex + 1}/${p.totalScenarios}, run ${p.replicationIndex + 1}/${p.totalReplications}`,
          });
        }, abortCtrl.signal);
        set({ phase: 'done', progress: 100, progressLabel: 'Complete', result, _abortCtrl: null });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          set({ phase: 'idle', progress: 0, progressLabel: '', error: null, _abortCtrl: null });
        } else {
          set({ phase: 'error', error: String(err), progress: 0, _abortCtrl: null });
        }
      }
    })();
  },

  cancel: () => {
    const ctrl = get()._abortCtrl;
    if (ctrl) ctrl.abort();
  },

  reset: () => {
    const ctrl = get()._abortCtrl;
    if (ctrl) ctrl.abort();
    set({
      phase: 'idle',
      progress: 0,
      progressLabel: '',
      result: null,
      error: null,
      _abortCtrl: null,
    });
  },
}));
