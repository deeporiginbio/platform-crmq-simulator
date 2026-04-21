/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Formula Registry
 * =================
 * Maps formula type IDs to their definitions.
 * These match the benchmark scoring formulas so the config page
 * and the benchmark system share the same formula set.
 */

import { z } from 'zod';
import type {
  FormulaDefinition,
  FormulaType,
  CurrentWeightedParams,
  NormalizedWeightedSumParams,
  DrfFairShareParams,
  BalancedCompositeParams,
  StrictFifoParams,
} from '../types';

// ── Schemas ─────────────────────────────────────────────────────────────────

export const currentWeightedSchema = z.object({
  orgWeight: z.number().min(0).max(100_000),
  userWeight: z.number().min(0).max(100_000),
  toolWeight: z.number().min(0).max(100_000),
  agingFactor: z.number().min(0).max(1000),
});

export const normalizedWeightedSumSchema = z.object({
  wTier: z.number().min(0).max(1),
  wAge: z.number().min(0).max(1),
  wUser: z.number().min(0).max(1),
  wTool: z.number().min(0).max(1),
  C: z.number().min(1).max(100),
  tau: z.number().min(1).max(3600),
});

export const drfFairShareSchema = z.object({
  C: z.number().min(1).max(100),
  tau: z.number().min(1).max(3600),
});

export const balancedCompositeSchema = z.object({
  wPriority: z.number().min(0).max(1),
  wAging: z.number().min(0).max(1),
  wLoad: z.number().min(0).max(1),
  wCpuHrs: z.number().min(0).max(1),
  agingHorizon: z.number().min(60).max(86400),
  agingExponent: z.number().min(1).max(5),
  agingFloor: z.number().min(0).max(0.5),
  maxCpuHours: z.number().min(1).max(100000),
});

export const strictFifoSchema = z.object({});

// ── Definitions ─────────────────────────────────────────────────────────────

const currentWeighted: FormulaDefinition<CurrentWeightedParams> = {
  id: 'current_weighted',
  label: 'Weighted Score (CRMQ Design)',
  description: 'Linear additive formula with fixed weights. Uses linear aging. The current production formula.',
  icon: '⚖️',
  schema: currentWeightedSchema,
  defaultParams: {
    orgWeight: 10_000,
    userWeight: 1_000,
    toolWeight: 100,
    agingFactor: 5,
  },
};

const normalizedWeightedSum: FormulaDefinition<NormalizedWeightedSumParams> = {
  id: 'normalized_weighted_sum',
  label: 'Normalized Weighted Sum + Log Aging',
  description: 'Research-recommended formula: normalized inputs summing to 1.0 with logarithmic aging for bounded starvation prevention.',
  icon: '📊',
  schema: normalizedWeightedSumSchema,
  defaultParams: {
    wTier: 0.30,
    wAge: 0.30,
    wUser: 0.25,
    wTool: 0.15,
    C: 10,
    tau: 60,
  },
};

const drfFairShare: FormulaDefinition<DrfFairShareParams> = {
  id: 'drf_fair_share',
  label: 'DRF Fair Share + Log Aging',
  description: 'Dominant Resource Fairness for inter-org scheduling, with normalized composite score and logarithmic aging within each org.',
  icon: '🤝',
  schema: drfFairShareSchema,
  defaultParams: {
    C: 10,
    tau: 60,
  },
};

const balancedComposite: FormulaDefinition<BalancedCompositeParams> = {
  id: 'balanced_composite',
  label: 'Balanced Composite (Deep Origin)',
  description:
    'Production formula: 0.35×priority + 0.25×aging'
    + ' + 0.20×(1−org_load) + 0.20×(1−cpu_hrs_norm).'
    + ' Blended aging (10% linear floor + 90% quadratic,'
    + ' full at 6h). CPU-only org load. cpu_hrs_norm is'
    + ' log-normalized against MAX_CPU_HOURS in vCPU·hours'
    + ' (default 1000, matching platform).',
  icon: '🎯',
  schema: balancedCompositeSchema,
  defaultParams: {
    wPriority: 0.35,
    wAging: 0.25,
    wLoad: 0.20,
    wCpuHrs: 0.20,
    agingHorizon: 21600,
    agingExponent: 2,
    agingFloor: 0.10,
    maxCpuHours: 1000,
  },
};

const strictFifo: FormulaDefinition<StrictFifoParams> = {
  id: 'strict_fifo',
  label: 'Strict FIFO (Baseline)',
  description: 'Pure first-in-first-out ordering. No priority, no aging. Useful as a baseline for comparison.',
  icon: '📐',
  schema: strictFifoSchema,
  defaultParams: {} as StrictFifoParams,
};

// ── Registry ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FORMULA_REGISTRY: Record<FormulaType, FormulaDefinition<any>> = {
  current_weighted: currentWeighted,
  normalized_weighted_sum: normalizedWeightedSum,
  drf_fair_share: drfFairShare,
  balanced_composite: balancedComposite,
  strict_fifo: strictFifo,
};

export const FORMULA_LIST = Object.values(FORMULA_REGISTRY);

/**
 * Migration map: old formula IDs → new formula IDs.
 * Handles stale localStorage values from before the formula unification.
 */
const LEGACY_FORMULA_MAP: Record<string, FormulaType> = {
  weighted_score: 'current_weighted',
  fair_share: 'drf_fair_share',
  strict_priority: 'strict_fifo',
};

/** Normalize a formula type, mapping legacy IDs to their new equivalents. */
export const normalizeFormulaType = (type: string): FormulaType => {
  if (type in FORMULA_REGISTRY) return type as FormulaType;
  if (type in LEGACY_FORMULA_MAP) return LEGACY_FORMULA_MAP[type];
  return 'balanced_composite';
};

/** Get formula definition. Falls back to balanced_composite for unknown/legacy types. */
export const getFormula = (type: FormulaType | string): FormulaDefinition => {
  const normalized = normalizeFormulaType(type);
  return FORMULA_REGISTRY[normalized];
};
