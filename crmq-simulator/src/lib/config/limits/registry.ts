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

const resourcesSchema = z.object({
  cpu: z.number().min(0),
  memory: z.number().min(0),
  gpu: z.number().min(0),
});

const percentageSchema = z.object({
  cpu: z.number().min(0).max(100),
  memory: z.number().min(0).max(100),
  gpu: z.number().min(0).max(100),
});

// ── Definitions ─────────────────────────────────────────────────────────────

const absoluteLimit: LimitDefinition<{ resources: Resources }> = {
  mode: 'absolute',
  label: 'Absolute',
  description: 'Fixed resource limits (e.g., 100 CPUs, 256 GB memory)',
  icon: '#️⃣',
  schema: z.object({ resources: resourcesSchema }),
  defaultValue: { resources: { cpu: 0, memory: 0, gpu: 0 } },
  resolve: (value) => value.resources,
};

const percentageLimit: LimitDefinition<{ pct: Resources }> = {
  mode: 'percentage',
  label: '% of Pool',
  description: 'Percentage of total pool capacity (e.g., 25% of CPU pool)',
  icon: '%',
  schema: z.object({ pct: percentageSchema }),
  defaultValue: { pct: { cpu: 100, memory: 100, gpu: 100 } },
  resolve: (value, poolTotal) => ({
    cpu: Math.round(poolTotal.cpu * value.pct.cpu / 100),
    memory: Math.round(poolTotal.memory * value.pct.memory / 100),
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
    cpu: poolTotal.cpu,
    memory: poolTotal.memory,
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
