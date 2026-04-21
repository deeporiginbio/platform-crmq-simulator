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
import type { AccountResource, CRMQConfig, Org, Resources } from './types';
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
        /** Optional on the wire for backward-compat; defaulted to zero on hydrate. */
        externalUsage?: Resources;
        /** Optional account-resource coupling key (§3.4). */
        accountResourceId?: string;
      }>;
    };
    ttlDefault: number;
    formulaType?: CRMQConfig['formulaType'];
    formulaParams?: CRMQConfig['formulaParams'];
    /** Optional shared account-level resources (§3.4). */
    accountResources?: AccountResource[];
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
  accountResources: cfg.accountResources,
});

const MIGRATION_KEY = 'crmq:migrated-v1';

/**
 * Detect active-config blobs from a prior schema era that is no longer
 * compatible with the current hydrator. Drop these rather than migrate.
 *
 * Eras detected:
 *  1. Pre-unit-rename: Resources used `cpu`/`memory` instead of
 *     `cpuMillis`/`memoryMiB`. Post-rename payloads always emit
 *     `cpuMillis`/`memoryMiB` somewhere; absence of both plus a raw
 *     `"cpu":<num>` or `"memory":<num>` marker signals the old shape.
 *  2. Pre-percent-only-quota: `Org.limits` held discriminated-union
 *     `LimitValue` objects (`mode: "absolute"|"percentage"|"uncapped"`)
 *     or raw Resources objects. Current shape is `Record<string, number>`.
 *     The presence of a `"mode":"absolute"`-style marker signals the
 *     union, and a nested `cpuMillis` under `"limits":{...}` signals the
 *     older Resources-as-limit shape.
 */
const isLegacyActiveConfig = (raw: string): boolean => {
  // Era 1: pre-unit-rename
  const hasNewUnits =
    raw.includes('"cpuMillis"') || raw.includes('"memoryMiB"');
  if (!hasNewUnits && /"(?:cpu|memory)"\s*:\s*-?\d/.test(raw)) {
    return true;
  }

  // Era 2a: legacy LimitValue discriminated union
  if (/"mode"\s*:\s*"(?:absolute|percentage|uncapped)"/.test(raw)) {
    return true;
  }

  // Era 2b: Resources-shaped org limits nested under `"limits":{...}`
  if (/"limits"\s*:\s*\{[^{}]*\{[^{}]*"cpuMillis"/.test(raw)) {
    return true;
  }

  return false;
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
