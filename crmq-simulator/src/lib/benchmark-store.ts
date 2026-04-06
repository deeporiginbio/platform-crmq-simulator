/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Benchmark Store
 * ================
 * Zustand store that manages benchmark execution state.
 * Supports multi-scenario + multi-formula sequential execution.
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

// ── Types ──────────────────────────────────────────────────────────

export type BenchmarkPhase =
  | 'idle'
  | 'configuring'
  | 'running'
  | 'done'
  | 'error';

export interface FormulaSelection {
  id: string;
  name: string;
  /** Optional config overrides for this formula */
  configOverrides?: Partial<CRMQConfig>;
}

/** Result for one workload scenario × all selected formulas */
export interface MultiScenarioEntry {
  preset: ScenarioPreset;
  result: BenchmarkSuiteResult;
}

interface BenchmarkStore {
  // ── State ──────────────────────────────────────────────────
  phase: BenchmarkPhase;
  /** Selected scenario preset IDs (multi-select) */
  selectedScenarioIds: string[];
  /** Selected formula IDs to compare */
  selectedFormulas: string[];
  /** Number of replications */
  replications: number;
  /** Progress 0–100 */
  progress: number;
  progressLabel: string;
  /** Legacy single-scenario result (kept for compat) */
  result: BenchmarkSuiteResult | null;
  /** Multi-scenario results — one entry per scenario */
  multiResults: MultiScenarioEntry[];
  /** Error message if something went wrong */
  error: string | null;
  /** AbortController for the current run (internal) */
  _abortCtrl: AbortController | null;

  // ── Actions ────────────────────────────────────────────────
  /** Replace entire scenario selection */
  setSelectedScenarios: (ids: string[]) => void;
  /** Toggle a single scenario on/off */
  toggleScenario: (id: string) => void;
  /** Select all scenarios */
  selectAllScenarios: () => void;
  /** Clear all scenarios */
  clearAllScenarios: () => void;
  toggleFormula: (id: string) => void;
  selectAllFormulas: () => void;
  setReplications: (n: number) => void;
  run: (config: CRMQConfig, orgs: Org[]) => void;
  cancel: () => void;
  reset: () => void;
}

// ── Store ──────────────────────────────────────────────────────────

export const useBenchmarkStore = create<BenchmarkStore>(
  (set, get) => ({
    phase: 'idle',
    selectedScenarioIds: ['steady-state'],
    selectedFormulas: [
      'current_weighted',
      'normalized_weighted_sum',
    ],
    replications: 30,
    progress: 0,
    progressLabel: '',
    result: null,
    multiResults: [],
    error: null,
    _abortCtrl: null,

    setSelectedScenarios: (ids) =>
      set({ selectedScenarioIds: ids }),

    toggleScenario: (id) => {
      const current = get().selectedScenarioIds;
      if (current.includes(id)) {
        if (current.length <= 1) return; // keep ≥1
        set({
          selectedScenarioIds: current.filter(
            (s) => s !== id,
          ),
        });
      } else {
        set({
          selectedScenarioIds: [...current, id],
        });
      }
    },

    selectAllScenarios: () =>
      set({
        selectedScenarioIds: SCENARIO_PRESETS.map(
          (p) => p.id,
        ),
      }),

    clearAllScenarios: () =>
      set({ selectedScenarioIds: ['steady-state'] }),

    toggleFormula: (id) => {
      const current = get().selectedFormulas;
      if (current.includes(id)) {
        if (current.length <= 1) return;
        set({
          selectedFormulas: current.filter(
            (f) => f !== id,
          ),
        });
      } else {
        set({ selectedFormulas: [...current, id] });
      }
    },

    selectAllFormulas: () =>
      set({
        selectedFormulas: getFormulas().map((f) => f.id),
      }),

    setReplications: (n) =>
      set({ replications: Math.max(1, Math.min(200, n)) }),

    run: (config, orgs) => {
      const {
        selectedScenarioIds,
        selectedFormulas,
        replications,
      } = get();
      const presets = selectedScenarioIds
        .map((id) =>
          SCENARIO_PRESETS.find((s) => s.id === id),
        )
        .filter(Boolean) as ScenarioPreset[];

      if (presets.length === 0) {
        set({
          phase: 'error',
          error: 'No scenarios selected',
        });
        return;
      }

      const formulas = getFormulas();
      const abortCtrl = new AbortController();
      set({
        phase: 'running',
        progress: 0,
        progressLabel: 'Starting...',
        error: null,
        result: null,
        multiResults: [],
        _abortCtrl: abortCtrl,
      });

      (async () => {
        try {
          const allResults: MultiScenarioEntry[] = [];

          for (
            let pi = 0;
            pi < presets.length;
            pi++
          ) {
            const preset = presets[pi];

            // Check cancellation
            if (abortCtrl.signal.aborted) {
              throw new DOMException(
                'Benchmark cancelled',
                'AbortError',
              );
            }

            // Build per-formula scenarios
            const scenarios = selectedFormulas.map(
              (fid) => {
                const formula = formulas.find(
                  (f) => f.id === fid,
                );
                return {
                  id: fid,
                  name: formula?.name ?? fid,
                  config: {
                    ...config,
                    formulaType:
                      fid === 'current_weighted'
                        ? config.formulaType
                        : (undefined as CRMQConfig['formulaType']),
                  },
                  orgs,
                  formulaId: fid,
                };
              },
            );

            const suiteConfig: BenchmarkSuiteConfig = {
              name:
                `${preset.name} — ` +
                `${selectedFormulas.length} formulas` +
                ` × ${replications} runs`,
              scenarios,
              workload: {
                durationSeconds:
                  preset.workloadConfig.durationSeconds,
                arrivalPattern:
                  preset.workloadConfig.arrivalPattern,
                sizeDistribution:
                  preset.workloadConfig.sizeDistribution,
                ttlDefault: config.ttlDefault,
              },
              replications,
              baseSeed: preset.workloadConfig.seed,
              warmUp: {
                type: 'fixed',
                seconds: Math.round(
                  preset.workloadConfig.durationSeconds *
                    0.1,
                ),
              },
            };

            // Progress: combine scenario-level + inner
            const scenarioBase =
              (pi / presets.length) * 100;
            const scenarioSpan =
              (1 / presets.length) * 100;

            const result = await runBenchmarkSuite(
              suiteConfig,
              (p) => {
                const innerPct =
                  scenarioBase +
                  (p.pct / 100) * scenarioSpan;
                set({
                  progress: Math.round(innerPct),
                  progressLabel:
                    `Scenario ${pi + 1}/${presets.length}` +
                    ` (${preset.name})` +
                    ` — ${p.phase}` +
                    ` — formula ${p.scenarioIndex + 1}` +
                    `/${p.totalScenarios}` +
                    `, run ${p.replicationIndex + 1}` +
                    `/${p.totalReplications}`,
                });
              },
              abortCtrl.signal,
            );

            allResults.push({ preset, result });
          }

          // If only 1 scenario, also set legacy result
          const singleResult =
            allResults.length === 1
              ? allResults[0].result
              : null;

          set({
            phase: 'done',
            progress: 100,
            progressLabel: 'Complete',
            result: singleResult,
            multiResults: allResults,
            _abortCtrl: null,
          });
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === 'AbortError'
          ) {
            set({
              phase: 'idle',
              progress: 0,
              progressLabel: '',
              error: null,
              _abortCtrl: null,
            });
          } else {
            set({
              phase: 'error',
              error: String(err),
              progress: 0,
              _abortCtrl: null,
            });
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
        multiResults: [],
        error: null,
        _abortCtrl: null,
      });
    },
  }),
);
