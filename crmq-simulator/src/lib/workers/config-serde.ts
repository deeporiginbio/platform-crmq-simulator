/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Config Serialization / Deserialization
 * ========================================
 * Shared utilities for preparing CRMQConfig for Web Worker transfer.
 *
 * ResourcePool.routeWhen is a function and cannot survive
 * `postMessage` (structured clone). We strip it before sending
 * and reconstruct it in the worker from `quotaType`.
 */

import type { CRMQConfig, Resources } from '../types';

// ── Serializable Pool (no functions) ────────────────────────────────

export interface SerializablePool {
  type: string;
  label: string;
  shortLabel: string;
  color: string;
  quotaType: 'cpu' | 'gpu';
  total: Resources;
  reserved: Resources;
}

export interface SerializableConfig {
  scoring: CRMQConfig['scoring'];
  scheduler: CRMQConfig['scheduler'];
  cluster: { pools: SerializablePool[] };
  ttlDefault: number;
  formulaType?: CRMQConfig['formulaType'];
  formulaParams?: CRMQConfig['formulaParams'];
}

// ── Strip (main thread → worker) ────────────────────────────────────

export const stripConfig = (
  cfg: CRMQConfig,
): SerializableConfig => ({
  scoring: cfg.scoring,
  scheduler: cfg.scheduler,
  cluster: {
    pools: cfg.cluster.pools.map(
      ({ routeWhen: _, ...rest }) => rest,
    ),
  },
  ttlDefault: isFinite(cfg.ttlDefault)
    ? cfg.ttlDefault
    : -1,
  formulaType: cfg.formulaType,
  formulaParams: cfg.formulaParams,
});

// ── Hydrate (inside the worker) ─────────────────────────────────────

export const hydrateConfig = (
  raw: SerializableConfig,
): CRMQConfig => ({
  scoring: raw.scoring,
  scheduler: raw.scheduler,
  cluster: {
    pools: raw.cluster.pools.map((sp) => ({
      ...sp,
      routeWhen: sp.quotaType === 'gpu'
        ? (job: { resources: Resources }) =>
            job.resources.gpu > 0
        : (job: { resources: Resources }) =>
            job.resources.gpu === 0,
    })),
  },
  ttlDefault:
    raw.ttlDefault == null || raw.ttlDefault <= 0
      ? Infinity
      : raw.ttlDefault,
  formulaType: raw.formulaType,
  formulaParams: raw.formulaParams,
});
