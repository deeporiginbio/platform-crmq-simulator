/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Shared Plotly configuration for all benchmark charts.
 * Used by BenchmarkCharts (single-scenario) and
 * CrossScenarioCharts (multi-scenario comparison).
 */

// ── Formula Color Palette ─────────────────────────────────
export const FORMULA_COLORS = [
  '#4A65DC', '#11A468', '#E8590C', '#9C36B5',
  '#2B8A3E', '#D6336C', '#1098AD', '#F59F00',
  '#495057', '#862E9C',
];

export const colorOf = (i: number): string =>
  FORMULA_COLORS[i % FORMULA_COLORS.length];

// ── Shared Plotly Layout ──────────────────────────────────
export const SHARED_LAYOUT: Record<string, unknown> = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#fafbfc',
  font: {
    family: 'Inter, system-ui, sans-serif',
    size: 11,
  },
  margin: { t: 8, r: 16, b: 40, l: 56 },
  bargap: 0.25,
  bargroupgap: 0.12,
};

// ── Shared Plotly Config ──────────────────────────────────
export const PLOTLY_CONFIG: Record<string, unknown> = {
  displayModeBar: false,
  responsive: true,
};

// ── Helpers ───────────────────────────────────────────────
export const truncName = (
  name: string,
  max = 20,
): string =>
  name.length > max
    ? name.slice(0, max - 1) + '…'
    : name;
