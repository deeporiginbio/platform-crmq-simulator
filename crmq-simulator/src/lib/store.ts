/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Shared Config Store
 * ====================
 * Zustand store that holds the CRMQConfig and Org[] state shared
 * between the Simulator and Configure pages.
 *
 * The active config auto-persists to localStorage so it survives
 * page refreshes and tab switches.
 */

import { create } from 'zustand';
import type { CRMQConfig, Org, Resources } from './types';
import { DEFAULT_CONFIG, DEFAULT_ORGS } from './scheduler';
import { hydrateConfig } from './persistence';

// ── Auto-save key for the active config ─────────────────────────────────────

const ACTIVE_KEY = 'crmq:active';

interface SerializedActive {
  config: {
    scoring: CRMQConfig['scoring'];
    scheduler: CRMQConfig['scheduler'];
    cluster: {
      pools: Array<{
        type: string;
        label: string;
        shortLabel: string;
        color: string;
        quotaType: 'cpu' | 'gpu';
        total: Resources;
        reserved: Resources;
      }>;
    };
    ttlDefault: number;
    formulaType?: CRMQConfig['formulaType'];
    formulaParams?: CRMQConfig['formulaParams'];
  };
  orgs: Org[];
}

/** Strip routeWhen for localStorage */
const stripForStorage = (cfg: CRMQConfig) => ({
  scoring: cfg.scoring,
  scheduler: cfg.scheduler,
  cluster: {
    pools: cfg.cluster.pools.map(({ routeWhen: _, ...rest }) => rest),
  },
  ttlDefault: cfg.ttlDefault,
  formulaType: cfg.formulaType,
  formulaParams: cfg.formulaParams,
});

const MIGRATION_KEY = 'crmq:migrated-v1';

/**
 * Detect pre-unit-rename active-config blobs (pool totals / org limits used
 * `cpu` / `memory` rather than `cpuMillis` / `memoryMiB`). The post-rename
 * payload always emits at least one `cpuMillis` / `memoryMiB` key on pool
 * resources, so presence of either is the "new-era" marker. A legacy blob
 * has `"cpu":<num>` or `"memory":<num>` with neither new key — hydrating
 * it would produce NaNs downstream.
 */
const isLegacyActiveConfig = (raw: string): boolean => {
  if (raw.includes('"cpuMillis"') || raw.includes('"memoryMiB"')) return false;
  return /"(?:cpu|memory)"\s*:\s*-?\d/.test(raw);
};

/** Load the last-active config from localStorage, with one-time migration */
const loadActiveConfig = (): { cfg: CRMQConfig; orgs: Org[] } | null => {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    if (isLegacyActiveConfig(raw)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[crmq] Dropping legacy active-config at "${ACTIVE_KEY}" ` +
        `(pre unit-rename; no cpuMillis/memoryMiB keys). ` +
        `Reverting to defaults.`,
      );
      localStorage.removeItem(ACTIVE_KEY);
      return null;
    }
    const parsed: SerializedActive = JSON.parse(raw);
    // One-time migration: switch old default to balanced_composite
    if (!localStorage.getItem(MIGRATION_KEY)) {
      if (!parsed.config.formulaType || parsed.config.formulaType === 'current_weighted') {
        parsed.config.formulaType = 'balanced_composite';
        parsed.config.formulaParams = undefined;
      }
      localStorage.setItem(MIGRATION_KEY, '1');
    }
    return {
      cfg: hydrateConfig(parsed.config),
      orgs: parsed.orgs,
    };
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[crmq] Failed to parse active-config at "${ACTIVE_KEY}"; clearing.`);
    try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
    return null;
  }
};

/** Persist the active config to localStorage */
const persistActiveConfig = (cfg: CRMQConfig, orgs: Org[]) => {
  try {
    const data: SerializedActive = { config: stripForStorage(cfg), orgs };
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(data));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
};

// ── Store ───────────────────────────────────────────────────────────────────

interface ConfigStore {
  cfg: CRMQConfig;
  orgs: Org[];

  /** Apply a new config + orgs (from Configure page) */
  applyConfig: (cfg: CRMQConfig, orgs: Org[]) => void;

  /** Reset to defaults */
  resetConfig: () => void;
}

// Try to restore last session's active config
const restored = typeof window !== 'undefined' ? loadActiveConfig() : null;

export const useConfigStore = create<ConfigStore>((set) => ({
  cfg: restored?.cfg ?? DEFAULT_CONFIG,
  orgs: restored?.orgs ?? DEFAULT_ORGS,

  applyConfig: (cfg, orgs) => {
    set({ cfg, orgs });
    persistActiveConfig(cfg, orgs);
  },

  resetConfig: () => {
    set({ cfg: DEFAULT_CONFIG, orgs: DEFAULT_ORGS });
    persistActiveConfig(DEFAULT_CONFIG, DEFAULT_ORGS);
  },
}));
