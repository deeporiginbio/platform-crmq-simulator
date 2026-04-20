/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Limit Registry
 * ================
 * Maps limit modes to their definitions.
 * Each limit type knows how to resolve itself to absolute Resources.
 */

import { z } from 'zod';
import type { Resources } from '../../types';
import type { LimitDefinition, LimitMode } from '../types';

// ── Schemas ─────────────────────────────────────────────────────────────────

// Absolute schema uses canonical model units (cpuMillis, memoryMiB). UI
// components convert at the boundary via src/lib/units.ts helpers.
const resourcesSchema = z.object({
  cpuMillis: z.number().min(0),
  memoryMiB: z.number().min(0),
  gpu: z.number().min(0),
});

// Percentage schema values are plain percentages [0, 100] — unit-agnostic.
const percentageSchema = z.object({
  cpuMillis: z.number().min(0).max(100),
  memoryMiB: z.number().min(0).max(100),
  gpu: z.number().min(0).max(100),
});

// ── Definitions ─────────────────────────────────────────────────────────────

const absoluteLimit: LimitDefinition<{ resources: Resources }> = {
  mode: 'absolute',
  label: 'Absolute',
  description: 'Fixed resource limits (e.g., 100 CPUs, 256 GB memory)',
  icon: '#️⃣',
  schema: z.object({ resources: resourcesSchema }),
  defaultValue: { resources: { cpuMillis: 0, memoryMiB: 0, gpu: 0 } },
  resolve: (value) => value.resources,
};

const percentageLimit: LimitDefinition<{ pct: Resources }> = {
  mode: 'percentage',
  label: '% of Pool',
  description: 'Percentage of total pool capacity (e.g., 25% of CPU pool)',
  icon: '%',
  schema: z.object({ pct: percentageSchema }),
  defaultValue: { pct: { cpuMillis: 100, memoryMiB: 100, gpu: 100 } },
  resolve: (value, poolTotal) => ({
    cpuMillis: Math.round(poolTotal.cpuMillis * value.pct.cpuMillis / 100),
    memoryMiB: Math.round(poolTotal.memoryMiB * value.pct.memoryMiB / 100),
    gpu: Math.round(poolTotal.gpu * value.pct.gpu / 100),
  }),
};

const uncappedLimit: LimitDefinition<Record<string, never>> = {
  mode: 'uncapped',
  label: 'Uncapped',
  description: 'No limit — org can use all available pool capacity',
  icon: '∞',
  schema: z.object({}),
  defaultValue: {},
  resolve: (_value, poolTotal) => ({
    cpuMillis: poolTotal.cpuMillis,
    memoryMiB: poolTotal.memoryMiB,
    gpu: poolTotal.gpu,
  }),
};

// ── Registry ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LIMIT_REGISTRY: Record<LimitMode, LimitDefinition<any>> = {
  absolute: absoluteLimit,
  percentage: percentageLimit,
  uncapped: uncappedLimit,
};

export const LIMIT_LIST = Object.values(LIMIT_REGISTRY);

/** Get limit definition, throws if not found */
export const getLimit = (mode: LimitMode): LimitDefinition => {
  const def = LIMIT_REGISTRY[mode];
  if (!def) throw new Error(`Unknown limit mode: ${mode}`);
  return def;
};

/** Resolve a LimitValue to absolute Resources */
export const resolveLimitToAbsolute = (
  limitValue: { mode: LimitMode } & Record<string, unknown>,
  poolTotal: Resources,
): Resources => {
  const def = getLimit(limitValue.mode);
  return def.resolve(limitValue, poolTotal);
};
