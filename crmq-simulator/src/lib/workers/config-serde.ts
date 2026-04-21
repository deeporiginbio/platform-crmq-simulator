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

import type { AccountResource, CRMQConfig, Resources } from '../types';

// ── Serializable Pool (no functions) ────────────────────────────────

export interface SerializablePool {
  type: string;
  label: string;
  shortLabel: string;
  color: string;
  quotaType: 'cpu' | 'gpu';
  total: Resources;
  reserved: Resources;
  /** Optional on the wire for backward-compat; defaulted to zero on hydrate. */
  externalUsage?: Resources;
  /** Optional account-resource coupling key (§3.4). */
  accountResourceId?: string;
}

export interface SerializableConfig {
  scoring: CRMQConfig['scoring'];
  scheduler: CRMQConfig['scheduler'];
  cluster: { pools: SerializablePool[] };
  ttlDefault: number;
  formulaType?: CRMQConfig['formulaType'];
  formulaParams?: CRMQConfig['formulaParams'];
  /** Optional shared account-level resources (§3.4). */
  accountResources?: AccountResource[];
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
  accountResources: cfg.accountResources,
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
      // Backward-compat: pools serialized before #5 didn't carry externalUsage.
      externalUsage: sp.externalUsage ?? { cpuMillis: 0, memoryMiB: 0, gpu: 0 },
      // Post-#4 signature: routeWhen takes a single Resources slice.
      routeWhen: sp.quotaType === 'gpu'
        ? (res: Resources) => res.gpu > 0
        : (res: Resources) => res.gpu === 0,
    })),
  },
  ttlDefault:
    raw.ttlDefault == null || raw.ttlDefault <= 0
      ? Infinity
      : raw.ttlDefault,
  formulaType: raw.formulaType,
  formulaParams: raw.formulaParams,
  accountResources: raw.accountResources,
});
