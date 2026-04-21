/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Config Form State Management
 * ==============================
 * useReducer-based state for the scheduling policy configuration form.
 *
 * Key design decisions:
 * - Discriminated unions on formula type ensure no stale params when
 *   switching formulas
 * - Limits are percentage-only (platform parity with
 *   `organizations.resourceQuota numeric(6,2) default 100`), so the reducer
 *   only exposes a single percent-per-pool action
 * - Deeply nested state is updated via targeted actions, not generic setPath
 */

import { useReducer, useCallback } from 'react';
import type { Resources, CRMQConfig, Org } from '../types';
import type {
  FormulaConfig,
  FormulaType,
  OrgQuotaConfig,
  SchedulingPolicyConfig,
} from './types';
import { getFormula, normalizeFormulaType } from './formulas/registry';

// ── Actions ─────────────────────────────────────────────────────────────────

type ConfigAction =
  // Formula
  | { type: 'SET_FORMULA_TYPE'; formulaType: FormulaType }
  | {
      type: 'SET_FORMULA_PARAM';
      key: string;
      value: number | boolean | string;
    }
  // Scheduler
  | {
      type: 'SET_SCHEDULER_PARAM';
      key: 'topN' | 'skipThreshold' | 'reservationThresholdSec' | 'backfillMaxRatio';
      value: number;
    }
  | { type: 'SET_TTL_DEFAULT'; value: number }
  // Cluster pools
  | {
      type: 'SET_POOL_RESOURCE';
      poolIdx: number;
      field: 'total' | 'reserved';
      dim: keyof Resources;
      value: number;
    }
  // Org quotas — percent-only
  | {
      type: 'SET_LIMIT_PCT_QUOTA';
      orgId: string;
      poolType: string;
      pctValue: number;
    }
  | { type: 'SET_ORG_PRIORITY'; orgId: string; value: number }
  // Bulk
  | { type: 'RESET'; config: SchedulingPolicyConfig };

// ── Reducer ─────────────────────────────────────────────────────────────────

const reducer = (
  state: SchedulingPolicyConfig,
  action: ConfigAction,
): SchedulingPolicyConfig => {
  switch (action.type) {
    case 'SET_FORMULA_TYPE': {
      const def = getFormula(action.formulaType);
      // Complete replacement — old formula's params are discarded
      return {
        ...state,
        formula: {
          type: action.formulaType,
          params: structuredClone(def.defaultParams),
        } as unknown as FormulaConfig,
      };
    }

    case 'SET_FORMULA_PARAM': {
      return {
        ...state,
        formula: {
          type: state.formula.type,
          params: {
            ...(state.formula.params as unknown as Record<string, unknown>),
            [action.key]: action.value,
          },
        } as unknown as FormulaConfig,
      };
    }

    case 'SET_SCHEDULER_PARAM': {
      return {
        ...state,
        scheduler: {
          ...state.scheduler,
          [action.key]: action.value,
        },
      };
    }

    case 'SET_TTL_DEFAULT': {
      return { ...state, ttlDefault: action.value };
    }

    case 'SET_POOL_RESOURCE': {
      const pools = [...state.cluster.pools];
      const pool = { ...pools[action.poolIdx] };
      pool[action.field] = {
        ...pool[action.field],
        [action.dim]: action.value,
      };
      pools[action.poolIdx] = pool;
      return { ...state, cluster: { ...state.cluster, pools } };
    }

    case 'SET_LIMIT_PCT_QUOTA': {
      // Single percentage per (org, pool), clamped to [0, 100]
      const pct = Math.max(0, Math.min(100, action.pctValue));
      return {
        ...state,
        orgQuotas: state.orgQuotas.map((oq) => {
          if (oq.orgId !== action.orgId) return oq;
          return {
            ...oq,
            limits: {
              ...oq.limits,
              [action.poolType]: pct,
            },
          };
        }),
      };
    }

    case 'SET_ORG_PRIORITY': {
      // Note: org priority is on the Org object, not OrgQuotaConfig.
      // This action is handled at the form level; included here for completeness.
      return state;
    }

    case 'RESET': {
      return action.config;
    }

    default:
      return state;
  }
};

// ── Hook ────────────────────────────────────────────────────────────────────

/**
 * Build the initial SchedulingPolicyConfig from existing CRMQConfig + Org[].
 * Limits are read straight through as percentages; missing keys default to
 * 100 (unlimited within the pool), matching the platform default.
 */
export const buildInitialConfig = (
  cfg: CRMQConfig,
  orgs: Org[],
): SchedulingPolicyConfig => {
  const formulaType = normalizeFormulaType(
    cfg.formulaType ?? 'balanced_composite',
  );
  const formulaDef = getFormula(formulaType);

  // If a saved formulaParams exists use it, otherwise fall back to scoring
  // (for current_weighted) or defaults
  const formulaParams = cfg.formulaParams
    ? cfg.formulaParams
    : formulaType === 'current_weighted'
      ? { ...cfg.scoring }
      : structuredClone(formulaDef.defaultParams);

  const orgQuotas: OrgQuotaConfig[] = orgs.map((org) => ({
    orgId: org.id,
    limits: Object.fromEntries(
      cfg.cluster.pools.map((pool) => [
        pool.type,
        org.limits[pool.type] ?? 100,
      ]),
    ),
  }));

  return {
    formula: {
      type: formulaType,
      params: formulaParams,
    } as unknown as FormulaConfig,
    scheduler: { ...cfg.scheduler },
    cluster: {
      pools: cfg.cluster.pools.map((p) => ({ ...p })),
    },
    orgQuotas,
    ttlDefault: cfg.ttlDefault,
  };
};

export const useConfigForm = (initialConfig: SchedulingPolicyConfig) => {
  const [state, dispatch] = useReducer(reducer, initialConfig);

  const setFormulaType = useCallback((formulaType: FormulaType) => {
    dispatch({ type: 'SET_FORMULA_TYPE', formulaType });
  }, []);

  const setFormulaParam = useCallback(
    (key: string, value: number | boolean | string) => {
      dispatch({ type: 'SET_FORMULA_PARAM', key, value });
    },
    [],
  );

  const setSchedulerParam = useCallback(
    (
      key: 'topN' | 'skipThreshold' | 'reservationThresholdSec' | 'backfillMaxRatio',
      value: number,
    ) => {
      dispatch({ type: 'SET_SCHEDULER_PARAM', key, value });
    },
    [],
  );

  const setTtlDefault = useCallback((value: number) => {
    dispatch({ type: 'SET_TTL_DEFAULT', value });
  }, []);

  const setPoolResource = useCallback(
    (
      poolIdx: number,
      field: 'total' | 'reserved',
      dim: keyof Resources,
      value: number,
    ) => {
      dispatch({
        type: 'SET_POOL_RESOURCE',
        poolIdx,
        field,
        dim,
        value,
      });
    },
    [],
  );

  const setLimitPctQuota = useCallback(
    (orgId: string, poolType: string, pctValue: number) => {
      dispatch({
        type: 'SET_LIMIT_PCT_QUOTA',
        orgId,
        poolType,
        pctValue,
      });
    },
    [],
  );

  const reset = useCallback((config: SchedulingPolicyConfig) => {
    dispatch({ type: 'RESET', config });
  }, []);

  return {
    state,
    dispatch,
    setFormulaType,
    setFormulaParam,
    setSchedulerParam,
    setTtlDefault,
    setPoolResource,
    setLimitPctQuota,
    reset,
  };
};
