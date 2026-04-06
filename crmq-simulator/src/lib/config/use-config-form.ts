/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Config Form State Management
 * ==============================
 * useReducer-based state for the scheduling policy configuration form.
 *
 * Key design decisions:
 * - Discriminated unions ensure no stale data from hidden/deselected formulas
 * - When switching formula type, old params are replaced with new defaults
 * - When switching limit mode, old limit data is replaced with new defaults
 * - Deeply nested state is updated via targeted actions, not generic setPath
 */

import { useReducer, useCallback } from 'react';
import type { Resources, CRMQConfig, Org } from '../types';
import type {
  FormulaConfig,
  FormulaType,
  LimitMode,
  LimitValue,
  OrgQuotaConfig,
  SchedulingPolicyConfig,
} from './types';
import { deriveResources } from './types';
import type { QuotaType } from '../types';
import { getFormula, normalizeFormulaType, FORMULA_REGISTRY } from './formulas/registry';
import { LIMIT_REGISTRY } from './limits/registry';

// ── Actions ─────────────────────────────────────────────────────────────────

type ConfigAction =
  // Formula
  | { type: 'SET_FORMULA_TYPE'; formulaType: FormulaType }
  | { type: 'SET_FORMULA_PARAM'; key: string; value: number | boolean | string }
  // Scheduler
  | { type: 'SET_SCHEDULER_PARAM'; key: 'topN' | 'skipThreshold' | 'backfillMaxRatio'; value: number }
  | { type: 'SET_TTL_DEFAULT'; value: number }
  // Cluster pools
  | { type: 'SET_POOL_RESOURCE'; poolIdx: number; field: 'total' | 'reserved'; dim: keyof Resources; value: number }
  // Org quotas
  | { type: 'SET_LIMIT_MODE'; orgId: string; poolType: string; mode: LimitMode }
  | { type: 'SET_LIMIT_VALUE'; orgId: string; poolType: string; key: string; dim: keyof Resources; value: number }
  | { type: 'SET_LIMIT_QUOTA'; orgId: string; poolType: string; quotaType: QuotaType; value: number }
  | { type: 'SET_LIMIT_PCT_QUOTA'; orgId: string; poolType: string; pctValue: number }
  | { type: 'SET_ORG_PRIORITY'; orgId: string; value: number }
  // Bulk
  | { type: 'RESET'; config: SchedulingPolicyConfig };

// ── Reducer ─────────────────────────────────────────────────────────────────

const reducer = (state: SchedulingPolicyConfig, action: ConfigAction): SchedulingPolicyConfig => {
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
          params: { ...(state.formula.params as unknown as Record<string, unknown>), [action.key]: action.value },
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
      pool[action.field] = { ...pool[action.field], [action.dim]: action.value };
      pools[action.poolIdx] = pool;
      return { ...state, cluster: { ...state.cluster, pools } };
    }

    case 'SET_LIMIT_MODE': {
      const limitDef = LIMIT_REGISTRY[action.mode];
      const newLimit: LimitValue = action.mode === 'uncapped'
        ? { mode: 'uncapped' }
        : action.mode === 'percentage'
          ? { mode: 'percentage', pct: { ...(limitDef.defaultValue as { pct: Resources }).pct } }
          : { mode: 'absolute', resources: { ...(limitDef.defaultValue as { resources: Resources }).resources } };

      return {
        ...state,
        orgQuotas: state.orgQuotas.map(oq =>
          oq.orgId === action.orgId
            ? { ...oq, limits: { ...oq.limits, [action.poolType]: newLimit } }
            : oq,
        ),
      };
    }

    case 'SET_LIMIT_VALUE': {
      return {
        ...state,
        orgQuotas: state.orgQuotas.map(oq => {
          if (oq.orgId !== action.orgId) return oq;
          const limit = oq.limits[action.poolType];
          if (!limit) return oq;

          if (limit.mode === 'absolute' && action.key === 'resources') {
            return {
              ...oq,
              limits: {
                ...oq.limits,
                [action.poolType]: {
                  ...limit,
                  resources: { ...limit.resources, [action.dim]: action.value },
                },
              },
            };
          }

          if (limit.mode === 'percentage' && action.key === 'pct') {
            return {
              ...oq,
              limits: {
                ...oq.limits,
                [action.poolType]: {
                  ...limit,
                  pct: { ...limit.pct, [action.dim]: action.value },
                },
              },
            };
          }

          return oq;
        }),
      };
    }

    case 'SET_LIMIT_QUOTA': {
      // User sets the single configurable dimension; the rest are derived
      return {
        ...state,
        orgQuotas: state.orgQuotas.map(oq => {
          if (oq.orgId !== action.orgId) return oq;
          const limit = oq.limits[action.poolType];
          if (!limit || limit.mode !== 'absolute') return oq;
          return {
            ...oq,
            limits: {
              ...oq.limits,
              [action.poolType]: {
                mode: 'absolute' as const,
                resources: deriveResources(action.quotaType, action.value),
              },
            },
          };
        }),
      };
    }

    case 'SET_LIMIT_PCT_QUOTA': {
      // User sets one % value; all dimensions use the same percentage
      return {
        ...state,
        orgQuotas: state.orgQuotas.map(oq => {
          if (oq.orgId !== action.orgId) return oq;
          const limit = oq.limits[action.poolType];
          if (!limit || limit.mode !== 'percentage') return oq;
          return {
            ...oq,
            limits: {
              ...oq.limits,
              [action.poolType]: {
                mode: 'percentage' as const,
                pct: { cpu: action.pctValue, memory: action.pctValue, gpu: action.pctValue },
              },
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
 * Converts the current flat limits to the discriminated union format.
 */
export const buildInitialConfig = (cfg: CRMQConfig, orgs: Org[]): SchedulingPolicyConfig => {
  const formulaType = normalizeFormulaType(cfg.formulaType ?? 'current_weighted');
  const formulaDef = getFormula(formulaType);

  // If a saved formulaParams exists use it, otherwise fall back to scoring (for current_weighted) or defaults
  const formulaParams = cfg.formulaParams
    ? cfg.formulaParams
    : formulaType === 'current_weighted'
      ? { ...cfg.scoring }
      : structuredClone(formulaDef.defaultParams);

  return {
    formula: {
      type: formulaType,
      params: formulaParams,
    } as unknown as FormulaConfig,
    scheduler: { ...cfg.scheduler },
    cluster: {
      pools: cfg.cluster.pools.map(p => ({ ...p })),
    },
    orgQuotas: orgs.map(org => ({
      orgId: org.id,
      limits: Object.fromEntries(
        cfg.cluster.pools.map(pool => [
          pool.type,
          {
            mode: 'absolute' as const,
            resources: { ...(org.limits[pool.type] ?? { cpu: 0, memory: 0, gpu: 0 }) },
          },
        ]),
      ),
    })),
    ttlDefault: cfg.ttlDefault,
  };
};

export const useConfigForm = (initialConfig: SchedulingPolicyConfig) => {
  const [state, dispatch] = useReducer(reducer, initialConfig);

  const setFormulaType = useCallback((formulaType: FormulaType) => {
    dispatch({ type: 'SET_FORMULA_TYPE', formulaType });
  }, []);

  const setFormulaParam = useCallback((key: string, value: number | boolean | string) => {
    dispatch({ type: 'SET_FORMULA_PARAM', key, value });
  }, []);

  const setSchedulerParam = useCallback((key: 'topN' | 'skipThreshold' | 'backfillMaxRatio', value: number) => {
    dispatch({ type: 'SET_SCHEDULER_PARAM', key, value });
  }, []);

  const setTtlDefault = useCallback((value: number) => {
    dispatch({ type: 'SET_TTL_DEFAULT', value });
  }, []);

  const setPoolResource = useCallback((poolIdx: number, field: 'total' | 'reserved', dim: keyof Resources, value: number) => {
    dispatch({ type: 'SET_POOL_RESOURCE', poolIdx, field, dim, value });
  }, []);

  const setLimitMode = useCallback((orgId: string, poolType: string, mode: LimitMode) => {
    dispatch({ type: 'SET_LIMIT_MODE', orgId, poolType, mode });
  }, []);

  const setLimitValue = useCallback((orgId: string, poolType: string, key: string, dim: keyof Resources, value: number) => {
    dispatch({ type: 'SET_LIMIT_VALUE', orgId, poolType, key, dim, value });
  }, []);

  const setLimitQuota = useCallback((orgId: string, poolType: string, quotaType: QuotaType, value: number) => {
    dispatch({ type: 'SET_LIMIT_QUOTA', orgId, poolType, quotaType, value });
  }, []);

  const setLimitPctQuota = useCallback((orgId: string, poolType: string, pctValue: number) => {
    dispatch({ type: 'SET_LIMIT_PCT_QUOTA', orgId, poolType, pctValue });
  }, []);

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
    setLimitMode,
    setLimitValue,
    setLimitQuota,
    setLimitPctQuota,
    reset,
  };
};
