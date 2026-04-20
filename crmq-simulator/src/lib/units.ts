/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Unit Conversions
 * ================
 * Canonical model units (cpuMillis, memoryMiB) mirror the platform's
 * ComputeResources shape. UI surface stays in vCPU + GB (really GiB, binary)
 * for operator ergonomics. Convert at the boundary — these helpers are the
 * only place that knowledge lives.
 *
 * Platform reference:
 *   platform/apps/tools-service/src/modules/priority-scoring/
 *     balanced-composite-scoring.strategy.ts:337
 *   rawCpuHrs = (cpuMillis / 1000) * (durationSec / 3600)
 */

/** 1 vCPU = 1000 cpuMillis. Round to integer to match platform storage. */
export const cpuMillisFromVcpu = (vcpu: number): number =>
  Math.round(vcpu * 1000);

/** Inverse of cpuMillisFromVcpu. Returns decimal vCPU (display-only). */
export const vcpuFromCpuMillis = (cpuMillis: number): number =>
  cpuMillis / 1000;

/**
 * 1 GiB = 1024 MiB. The UI "GB" label is treated as GiB (binary), matching
 * the platform's MiB convention. Round to integer to keep model values clean.
 */
export const memoryMiBFromGb = (gb: number): number =>
  Math.round(gb * 1024);

/** Inverse of memoryMiBFromGb. Returns decimal GB (display-only). */
export const gbFromMemoryMiB = (mib: number): number =>
  mib / 1024;
