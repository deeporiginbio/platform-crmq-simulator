/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Benchmark Store
 * ================
 * Zustand store that manages benchmark execution state.
 * Supports multi-scenario + multi-formula sequential execution.
 *
 * All DES work runs inside a Web Worker so the main thread
 * (and the UI) never blocks during long-running benchmarks.
 */

import { create } from 'zustand';
import type { CRMQConfig, Org } from './types';
import {
  getFormulas,
  SCENARIO_PRESETS,
} from './benchmark';
import type {
  BenchmarkSuiteResult,
  ScenarioPreset,
} from './benchmark';
import { stripConfig } from './workers/config-serde';
import type {
  BenchmarkResponse,
  SerializableSuiteConfig,
  SerializableScenarioConfig,
} from './workers/benchmark.worker';
import {
  saveReport,
  genId,
} from './persistence';
import type {
  SavedMultiScenarioEntry,
} from './persistence';
import type {
  BenchmarkReport,
} from './config/types';

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
  configOverrides?: Partial<CRMQConfig>;
}

export interface MultiScenarioEntry {
  preset: ScenarioPreset;
  result: BenchmarkSuiteResult;
}

interface BenchmarkStore {
  phase: BenchmarkPhase;
  selectedScenarioIds: string[];
  selectedFormulas: string[];
  replications: number;
  progress: number;
  progressLabel: string;
  result: BenchmarkSuiteResult | null;
  multiResults: MultiScenarioEntry[];
  error: string | null;

  setSelectedScenarios: (ids: string[]) => void;
  toggleScenario: (id: string) => void;
  selectAllScenarios: () => void;
  clearAllScenarios: () => void;
  toggleFormula: (id: string) => void;
  selectAllFormulas: () => void;
  setReplications: (n: number) => void;
  run: (config: CRMQConfig, orgs: Org[]) => void;
  cancel: () => void;
  reset: () => void;
}

// ── Worker Singleton ──────────────────────────────────────────────

let _worker: Worker | null = null;

const getWorker = (): Worker | null => {
  if (typeof window === 'undefined') return null;
  if (!_worker) {
    try {
      _worker = new Worker(
        new URL(
          './workers/benchmark.worker.ts',
          import.meta.url,
        ),
      );
    } catch {
      return null;
    }
  }
  return _worker;
};

// ── Auto-save Report ──────────────────────────────────────────────

/**
 * Build a BenchmarkReport from completed results
 * and persist it via the persistence layer.
 */
const autoSaveReport = (
  results: MultiScenarioEntry[],
) => {
  if (results.length === 0) return;

  try {
    const formulaNames =
      results[0].result.scenarios.map(
        (s) => s.scenarioName,
      );
    const scenarioNames = results.map(
      (r) => r.preset.name,
    );

    const scenarioLabel =
      scenarioNames.join(', ');
    const reportName =
      `Benchmark — ${scenarioLabel}`;

    const report: BenchmarkReport = {
      id: genId(),
      name: reportName,
      createdAt: Date.now(),
      benchmarkRunId: genId(),
      summary:
        `Compared ${formulaNames.length}` +
        ` formula(s) across` +
        ` ${results.length} scenario(s).`,
      formulaNames,
      scenarioNames,
    };

    const savedEntries: SavedMultiScenarioEntry[] =
      results.map((r) => ({
        preset: r.preset,
        result: r.result,
      }));
    saveReport(
      reportName,
      report,
      undefined,
      savedEntries,
    );
  } catch {
    // Don't break the UI if auto-save fails
    console.warn(
      'Failed to auto-save benchmark report',
    );
  }
};

// ── Store ──────────────────────────────────────────────────────────

export const useBenchmarkStore =
  create<BenchmarkStore>((set, get) => ({
    phase: 'idle',
    selectedScenarioIds: ['multi-tenant-steady-state'],
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

    setSelectedScenarios: (ids) =>
      set({ selectedScenarioIds: ids }),

    toggleScenario: (id) => {
      const current = get().selectedScenarioIds;
      if (current.includes(id)) {
        if (current.length <= 1) return;
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
        selectedScenarioIds: SCENARIO_PRESETS
          .filter((p) => !p.benchmarkOnly)
          .map((p) => p.id),
      }),

    clearAllScenarios: () =>
      set({
        selectedScenarioIds: [
          'multi-tenant-competition',
        ],
      }),

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
        set({
          selectedFormulas: [...current, id],
        });
      }
    },

    selectAllFormulas: () =>
      set({
        selectedFormulas: getFormulas().map(
          (f) => f.id,
        ),
      }),

    setReplications: (n) =>
      set({
        replications: Math.max(
          1,
          Math.min(200, n),
        ),
      }),

    run: (config, orgs) => {
      const {
        selectedScenarioIds,
        selectedFormulas,
        replications,
      } = get();
      const presets = selectedScenarioIds
        .map((id) =>
          SCENARIO_PRESETS.find(
            (s) => s.id === id,
          ),
        )
        .filter(Boolean) as ScenarioPreset[];

      if (presets.length === 0) {
        set({
          phase: 'error',
          error: 'No scenarios selected',
        });
        return;
      }

      const worker = getWorker();
      if (!worker) {
        set({
          phase: 'error',
          error: 'Web Worker unavailable',
        });
        return;
      }

      const formulas = getFormulas();

      set({
        phase: 'running',
        progress: 0,
        progressLabel: 'Starting...',
        error: null,
        result: null,
        multiResults: [],
      });

      // Build one suite config per preset and
      // run them sequentially inside the worker
      // by dispatching one at a time.
      const allResults: MultiScenarioEntry[] = [];
      let currentPresetIndex = 0;

      const runNextPreset = () => {
        if (
          currentPresetIndex >= presets.length
        ) {
          // All done
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
          });

          // Auto-save report to localStorage
          autoSaveReport(allResults);
          return;
        }

        const preset =
          presets[currentPresetIndex];
        const pi = currentPresetIndex;

        const scenarios: SerializableScenarioConfig[] =
          selectedFormulas.map((fid) => {
            const formula = formulas.find(
              (f) => f.id === fid,
            );
            return {
              id: fid,
              name: formula?.name ?? fid,
              config: stripConfig({
                ...config,
                formulaType:
                  fid === 'current_weighted'
                    ? config.formulaType
                    : (undefined as CRMQConfig['formulaType']),
              }),
              orgs,
              formulaId: fid,
            };
          });

        const suite: SerializableSuiteConfig = {
          name:
            `${preset.name} — ` +
            `${selectedFormulas.length}` +
            ` formulas` +
            ` × ${replications} runs`,
          scenarios,
          workload: {
            durationSeconds:
              preset.workloadConfig
                .durationSeconds,
            arrivalPattern:
              preset.workloadConfig
                .arrivalPattern,
            sizeDistribution:
              preset.workloadConfig
                .sizeDistribution,
            ttlDefault: config.ttlDefault,
          },
          replications,
          baseSeed:
            preset.workloadConfig.seed,
          maxSimTime: undefined,
          warmUp: {
            type: 'fixed',
            seconds: Math.round(
              preset.workloadConfig
                .durationSeconds * 0.1,
            ),
          },
        };

        const scenarioBase =
          (pi / presets.length) * 100;
        const scenarioSpan =
          (1 / presets.length) * 100;

        // Wire up worker message handler
        // for this preset
        const handler = (
          ev: MessageEvent<BenchmarkResponse>,
        ) => {
          const msg = ev.data;

          if (msg.type === 'progress') {
            const p = msg.progress;
            const innerPct =
              scenarioBase +
              (p.pct / 100) * scenarioSpan;
            set({
              progress: Math.round(innerPct),
              progressLabel:
                `Scenario ` +
                `${pi + 1}` +
                `/${presets.length}` +
                ` (${preset.name})` +
                ` — ${p.phase}` +
                ` — formula ` +
                `${p.scenarioIndex + 1}` +
                `/${p.totalScenarios}` +
                `, run ` +
                `${p.replicationIndex + 1}` +
                `/${p.totalReplications}`,
            });
          }

          if (msg.type === 'result') {
            worker.removeEventListener(
              'message',
              handler,
            );
            allResults.push({
              preset,
              result: msg.result,
            });
            currentPresetIndex++;
            runNextPreset();
          }

          if (msg.type === 'error') {
            worker.removeEventListener(
              'message',
              handler,
            );
            if (msg.error === 'AbortError') {
              set({
                phase: 'idle',
                progress: 0,
                progressLabel: '',
                error: null,
              });
            } else {
              set({
                phase: 'error',
                error: msg.error,
                progress: 0,
              });
            }
          }
        };

        worker.addEventListener(
          'message',
          handler,
        );
        worker.postMessage({
          type: 'run',
          suiteConfig: suite,
        });
      };

      runNextPreset();
    },

    cancel: () => {
      const worker = getWorker();
      if (worker) {
        worker.postMessage({ type: 'abort' });
      }
    },

    reset: () => {
      const worker = getWorker();
      if (worker) {
        worker.postMessage({ type: 'abort' });
      }
      set({
        phase: 'idle',
        progress: 0,
        progressLabel: '',
        result: null,
        multiResults: [],
        error: null,
      });
    },
  }));

// Debug: expose store on window for testing
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)
    .__benchmarkStore = useBenchmarkStore;
}
