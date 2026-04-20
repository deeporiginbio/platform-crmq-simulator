/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Config Validation Hooks
 * ========================
 * Cross-field validation for the scheduling policy configuration.
 *
 * Three layers:
 * 1. Field-level: handled by Zod schemas in registries
 * 2. Cross-field within section: percentage sums, formula/limit compatibility
 * 3. Cross-section: formula ↔ limit type compatibility
 */

import { useMemo } from 'react';
import type { Resources } from '../types';
import type {
  SchedulingPolicyConfig,
  ValidationMessage,
  LimitMode,
  OrgQuotaConfig,
} from './types';
import { getFormula } from './formulas/registry';
import { resolveLimitToAbsolute } from './limits/registry';
import { vcpuFromCpuMillis } from '../units';

// ── Per-Pool Percentage Sum Validation ──────────────────────────────────────

/**
 * Checks if percentage-based limits across orgs exceed 100% for any pool/dimension.
 * This is a WARNING, not an error — oversubscription can be intentional.
 */
const validatePercentageSums = (
  orgQuotas: OrgQuotaConfig[],
  poolTypes: string[],
): ValidationMessage[] => {
  const warnings: ValidationMessage[] = [];

  for (const poolType of poolTypes) {
    const pctOrgs = orgQuotas.filter(
      oq => oq.limits[poolType]?.mode === 'percentage',
    );

    if (pctOrgs.length === 0) continue;

    // Only check CPU — memory and GPU are derived from CPU.
    // Percentage limits are unit-agnostic (plain [0,100]); we read the
    // canonical `cpuMillis` slot of the percentage Resources object.
    let cpuTotal = 0;
    for (const oq of pctOrgs) {
      const limit = oq.limits[poolType];
      if (limit.mode === 'percentage') {
        cpuTotal += limit.pct.cpuMillis;
      }
    }

    if (cpuTotal > 100) {
      warnings.push({
        severity: 'warning',
        pool: poolType,
        message: `CPU % limits for pool "${poolType}" sum to ${cpuTotal}% — oversubscribed by ${cpuTotal - 100}%`,
      });
    }
  }

  return warnings;
};

// ── Formula ↔ Limit Compatibility Validation ────────────────────────────────

/**
 * Checks if any org's limit mode is incompatible with the selected formula.
 * This is an ERROR — the config can't work as specified.
 */
const validateFormulaLimitCompatibility = (
  config: SchedulingPolicyConfig,
  poolTypes: string[],
): ValidationMessage[] => {
  const errors: ValidationMessage[] = [];

  const formulaDef = getFormula(config.formula.type);
  const compatibleModes = new Set(formulaDef.compatibleLimitTypes);

  for (const oq of config.orgQuotas) {
    for (const poolType of poolTypes) {
      const limit = oq.limits[poolType];
      if (!limit) continue;

      if (!compatibleModes.has(limit.mode)) {
        errors.push({
          severity: 'error',
          orgId: oq.orgId,
          pool: poolType,
          message: `"${formulaDef.label}" formula does not support "${limit.mode}" limits. Change the limit mode for org "${oq.orgId}" in pool "${poolType}" to: ${formulaDef.compatibleLimitTypes.join(', ')}`,
        });
      }
    }
  }

  return errors;
};

// ── Resolved Limits vs Pool Capacity ────────────────────────────────────────

/**
 * Checks if any single org's resolved limits exceed the pool's total capacity.
 * This is an ERROR — an org can never use more than the pool has.
 */
const validateLimitsVsCapacity = (
  config: SchedulingPolicyConfig,
): ValidationMessage[] => {
  const errors: ValidationMessage[] = [];

  for (const pool of config.cluster.pools) {
    for (const oq of config.orgQuotas) {
      const limit = oq.limits[pool.type];
      if (!limit || limit.mode === 'uncapped') continue;

      // Only validate CPU — memory and GPU are derived from CPU.
      // Compare in canonical cpuMillis; display values in UI-facing vCPU.
      const resolved = resolveLimitToAbsolute(limit, pool.total);

      if (
        resolved.cpuMillis > pool.total.cpuMillis
        && pool.total.cpuMillis > 0
      ) {
        errors.push({
          severity: 'error',
          orgId: oq.orgId,
          pool: pool.type,
          field: `orgQuotas.${oq.orgId}.${pool.type}.cpu`,
          message:
            `Org "${oq.orgId}" CPU limit`
            + ` (${vcpuFromCpuMillis(resolved.cpuMillis)} vCPU)`
            + ` exceeds pool "${pool.type}" total capacity`
            + ` (${vcpuFromCpuMillis(pool.total.cpuMillis)} vCPU)`,
        });
      }
    }
  }

  return errors;
};

// ── Combined Validation Hook ────────────────────────────────────────────────

export const useConfigValidation = (config: SchedulingPolicyConfig) => {
  const poolTypes = useMemo(
    () => config.cluster.pools.map(p => p.type),
    [config.cluster.pools],
  );

  const messages = useMemo<ValidationMessage[]>(() => {
    return [
      ...validatePercentageSums(config.orgQuotas, poolTypes),
      ...validateFormulaLimitCompatibility(config, poolTypes),
      ...validateLimitsVsCapacity(config),
    ];
  }, [config, poolTypes]);

  const errors = useMemo(() => messages.filter(m => m.severity === 'error'), [messages]);
  const warnings = useMemo(() => messages.filter(m => m.severity === 'warning'), [messages]);
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;

  return { messages, errors, warnings, hasErrors, hasWarnings };
};

// ── Utility: Resolved Limits Preview ────────────────────────────────────────

/**
 * Returns the effective absolute Resources for each org/pool combo.
 * Used in the Review step and Benchmark snapshot.
 */
export const resolveAllLimits = (
  config: SchedulingPolicyConfig,
): Record<string, Record<string, Resources>> => {
  const result: Record<string, Record<string, Resources>> = {};

  for (const oq of config.orgQuotas) {
    result[oq.orgId] = {};
    for (const pool of config.cluster.pools) {
      const limit = oq.limits[pool.type];
      if (!limit || limit.mode === 'uncapped') {
        result[oq.orgId][pool.type] = { ...pool.total };
      } else {
        result[oq.orgId][pool.type] = resolveLimitToAbsolute(limit, pool.total);
      }
    }
  }

  return result;
};
