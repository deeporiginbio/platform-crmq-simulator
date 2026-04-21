/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Config Validation Hooks
 * ========================
 * Cross-field validation for the scheduling policy configuration.
 *
 * Two layers:
 * 1. Field-level: handled by Zod schemas in registries
 * 2. Cross-field: percentage sums per pool (oversubscription warning)
 *
 * Formula ↔ limit-mode compatibility is no longer modeled — all formulas
 * operate on percentage quotas, matching the platform schema.
 */

import { useMemo } from 'react';
import type { Resources } from '../types';
import type {
  SchedulingPolicyConfig,
  ValidationMessage,
  OrgQuotaConfig,
} from './types';
import { resolveLimitToAbsolute } from './limits/registry';

// ── Per-Pool Percentage Sum Validation ──────────────────────────────────────

/**
 * Checks whether percent limits across orgs exceed 100% for any pool. This
 * is a WARNING, not an error — oversubscription is often intentional (the
 * platform's default is 100% per org, so N orgs sum to N×100%).
 */
const validatePercentageSums = (
  orgQuotas: OrgQuotaConfig[],
  poolTypes: string[],
): ValidationMessage[] => {
  const warnings: ValidationMessage[] = [];

  for (const poolType of poolTypes) {
    let total = 0;
    let counted = 0;
    for (const oq of orgQuotas) {
      const pct = oq.limits[poolType];
      if (typeof pct === 'number') {
        total += pct;
        counted += 1;
      }
    }

    if (counted > 0 && total > 100) {
      warnings.push({
        severity: 'warning',
        pool: poolType,
        message:
          `Org quotas for pool "${poolType}" sum to ${total}% —`
          + ` oversubscribed by ${total - 100}%`,
      });
    }
  }

  return warnings;
};

// ── Combined Validation Hook ────────────────────────────────────────────────

export const useConfigValidation = (config: SchedulingPolicyConfig) => {
  const poolTypes = useMemo(
    () => config.cluster.pools.map((p) => p.type),
    [config.cluster.pools],
  );

  const messages = useMemo<ValidationMessage[]>(() => {
    return [...validatePercentageSums(config.orgQuotas, poolTypes)];
  }, [config, poolTypes]);

  const errors = useMemo(
    () => messages.filter((m) => m.severity === 'error'),
    [messages],
  );
  const warnings = useMemo(
    () => messages.filter((m) => m.severity === 'warning'),
    [messages],
  );
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;

  return { messages, errors, warnings, hasErrors, hasWarnings };
};

// ── Utility: Resolved Limits Preview ────────────────────────────────────────

/**
 * Returns the effective absolute Resources for each org/pool combo. Used in
 * the Review step and Benchmark snapshot. Missing quotas resolve to the
 * full pool total (treated as unlimited-within-pool).
 */
export const resolveAllLimits = (
  config: SchedulingPolicyConfig,
): Record<string, Record<string, Resources>> => {
  const result: Record<string, Record<string, Resources>> = {};

  for (const oq of config.orgQuotas) {
    result[oq.orgId] = {};
    for (const pool of config.cluster.pools) {
      const pct = oq.limits[pool.type];
      if (typeof pct !== 'number') {
        result[oq.orgId][pool.type] = { ...pool.total };
      } else {
        result[oq.orgId][pool.type] = resolveLimitToAbsolute(
          pct,
          pool.total,
        );
      }
    }
  }

  return result;
};
