/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Benchmark Web Worker
 * =====================
 * Runs the DES benchmark suite off the main thread so the UI
 * stays responsive during long-running benchmarks.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: 'run', suiteConfig, scenarioConfigs }
 *     { type: 'abort' }
 *   Worker → Main:
 *     { type: 'progress', progress }
 *     { type: 'result', result }
 *     { type: 'error', error }
 */

import type { Org, CRMQConfig } from '../types';
import { runBenchmarkSuite } from '../benchmark/runner';
import type {
  BenchmarkSuiteConfig,
  BenchmarkSuiteResult,
  ProgressCallback,
  BenchmarkScenarioConfig,
} from '../benchmark/runner';
import { getFormula } from '../benchmark/scoring';
import {
  hydrateConfig,
  type SerializableConfig,
} from './config-serde';

// ── Message Types ───────────────────────────────────────────────────

/** Serializable version of BenchmarkScenarioConfig */
export interface SerializableScenarioConfig {
  id: string;
  name: string;
  config: SerializableConfig;
  orgs: Org[];
  formulaId?: string;
}

/** Serializable version of BenchmarkSuiteConfig */
export interface SerializableSuiteConfig {
  name: string;
  scenarios: SerializableScenarioConfig[];
  workload: BenchmarkSuiteConfig['workload'];
  replications: number;
  baseSeed: number;
  maxSimTime?: number;
  warmUp: BenchmarkSuiteConfig['warmUp'];
}

export interface BenchmarkRunRequest {
  type: 'run';
  suiteConfig: SerializableSuiteConfig;
}

export interface BenchmarkAbortRequest {
  type: 'abort';
}

export type BenchmarkRequest =
  | BenchmarkRunRequest
  | BenchmarkAbortRequest;

export interface BenchmarkProgressMsg {
  type: 'progress';
  progress: Parameters<ProgressCallback>[0];
}

export interface BenchmarkResultMsg {
  type: 'result';
  result: BenchmarkSuiteResult;
}

export interface BenchmarkErrorMsg {
  type: 'error';
  error: string;
}

export type BenchmarkResponse =
  | BenchmarkProgressMsg
  | BenchmarkResultMsg
  | BenchmarkErrorMsg;

// ── Worker Entry Point ──────────────────────────────────────────────

const ctx = self as unknown as Worker;
let _abortCtrl: AbortController | null = null;

ctx.onmessage = (e: MessageEvent<BenchmarkRequest>) => {
  const msg = e.data;

  if (msg.type === 'abort') {
    _abortCtrl?.abort();
    return;
  }

  if (msg.type === 'run') {
    _abortCtrl = new AbortController();

    // Rehydrate configs (restore routeWhen functions)
    const scenarios: BenchmarkScenarioConfig[] =
      msg.suiteConfig.scenarios.map((s) => ({
        id: s.id,
        name: s.name,
        config: hydrateConfig(s.config),
        orgs: s.orgs,
        formulaId: s.formulaId,
      }));

    const suiteConfig: BenchmarkSuiteConfig = {
      ...msg.suiteConfig,
      scenarios,
    };

    runBenchmarkSuite(
      suiteConfig,
      (progress) => {
        const resp: BenchmarkProgressMsg = {
          type: 'progress',
          progress,
        };
        ctx.postMessage(resp);
      },
      _abortCtrl.signal,
    )
      .then((result) => {
        const resp: BenchmarkResultMsg = {
          type: 'result',
          result,
        };
        ctx.postMessage(resp);
      })
      .catch((err) => {
        if (
          err instanceof DOMException &&
          err.name === 'AbortError'
        ) {
          // Cancellation — the main thread already knows
          const resp: BenchmarkErrorMsg = {
            type: 'error',
            error: 'AbortError',
          };
          ctx.postMessage(resp);
        } else {
          const resp: BenchmarkErrorMsg = {
            type: 'error',
            error: String(err),
          };
          ctx.postMessage(resp);
        }
      });
  }
};
