/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Limit Registry — percentage-only.
 * =================================
 * The CRMQ platform stores quotas as a single percentage per (org, pool)
 * (see `organizations.resourceQuota numeric(6,2) default 100`). Legacy
 * "absolute" and "uncapped" modes have been removed; this module now just
 * exposes the single resolver used by validation/summary layers.
 */

import type { Resources } from '../../types';
import { resolvePercentToResources } from '../types';

/** Resolve a percent quota [0, 100] to absolute Resources against a pool total. */
export const resolveLimitToAbsolute = (
  pct: number,
  poolTotal: Resources,
): Resources => resolvePercentToResources(pct, poolTotal);
