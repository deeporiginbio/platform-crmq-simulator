/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

/**
 * Cross-Scenario Comparison Charts
 * ==================================
 * Visualises the 3D dataset of Metric × Formula × Workload
 * Scenario that a multi-scenario benchmark produces.
 *
 * Charts:
 *   1. Meta Radar Scorecard — averaged normalised scores
 *   2. Grouped Bar Charts — per metric across scenarios
 *   3. Win-Rate Stacked Bar — % of scenarios each formula won
 */

import { useMemo } from 'react';
import { Box, Stack, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import type { PlotParams } from 'react-plotly.js';
import type { MultiScenarioEntry } from
  '@/lib/benchmark-store';
import type {
  AggregatedMetrics,
} from '@/lib/benchmark';
import {
  colorOf,
  SHARED_LAYOUT,
  PLOTLY_CONFIG,
  truncName,
} from '@/lib/benchmark/chart-utils';

// ── Plotly component (lazy-loaded to avoid SSR `self` error) ───
const Plot = dynamic(
  () => import('plotly.js-dist-min').then((Plotly) =>
    import('react-plotly.js/factory').then((mod) => mod.default(Plotly.default ?? Plotly)),
  ),
  { ssr: false },
) as React.ComponentType<PlotParams>;

// ── Chart Card (consistent with benchmark-charts) ─────────
const ChartCard = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) => (
  <Box
    p="md"
    style={{
      border: '1px solid #E5E7EA',
      borderRadius: 8,
      background: '#fff',
    }}
  >
    <Text size="sm" fw={600} c="grey.8">
      {title}
    </Text>
    {subtitle && (
      <Text size="xs" c="dimmed" mb="sm">
        {subtitle}
      </Text>
    )}
    <Box mt="xs">{children}</Box>
  </Box>
);

// ── Metric definitions ────────────────────────────────────
interface MetricDef {
  key: string;
  label: string;
  radarLabel: string;
  unit: string;
  direction: 'higher-better' | 'lower-better';
  extract: (a: AggregatedMetrics) => number;
  format: (v: number) => string;
}

const fmtTime = (sec: number): string => {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(2)}h`;
};

const METRICS: MetricDef[] = [
  {
    key: 'throughput',
    label: 'Throughput',
    radarLabel: 'Throughput',
    unit: 'jobs/min',
    direction: 'higher-better',
    extract: (a) => a.throughput.mean,
    format: (v) => v.toFixed(3),
  },
  {
    key: 'jainsIndex',
    label: "Jain's Fairness",
    radarLabel: 'Fairness',
    unit: '',
    direction: 'higher-better',
    extract: (a) => a.jainsIndex.mean,
    format: (v) => v.toFixed(4),
  },
  {
    key: 'meanWaitTime',
    label: 'Mean Wait Time',
    radarLabel: 'Mean Wait',
    unit: '',
    direction: 'lower-better',
    extract: (a) => a.meanWaitTime.mean,
    format: fmtTime,
  },
  {
    key: 'p95WaitTime',
    label: 'P95 Wait Time',
    radarLabel: 'Tail Wait (P95)',
    unit: '',
    direction: 'lower-better',
    extract: (a) => a.p95WaitTime.mean,
    format: fmtTime,
  },
];

// ── Props ─────────────────────────────────────────────────
interface Props {
  entries: MultiScenarioEntry[];
}

// ── Main Component ────────────────────────────────────────
export const CrossScenarioCharts = (
  { entries }: Props,
) => {
  // entries = one per workload scenario
  // each entry.result.scenarios = one per formula
  const formulaNames = useMemo(
    () =>
      entries[0]?.result.scenarios.map(
        (s) => s.scenarioName,
      ) ?? [],
    [entries],
  );

  const scenarioNames = useMemo(
    () => entries.map((e) => e.preset.name),
    [entries],
  );

  // ──────────────────────────────────────────────────────
  // 1. Meta Radar Scorecard
  //    Average normalised score per formula across all
  //    scenarios for each metric axis.
  // ──────────────────────────────────────────────────────
  const radarTraces = useMemo(() => {
    // For each formula, collect raw metric values per
    // scenario, normalise within each scenario, then
    // average across scenarios.
    const nFormulas = formulaNames.length;
    const nMetrics = METRICS.length;

    // scores[formulaIdx][metricIdx] = average norm score
    const scores: number[][] = Array.from(
      { length: nFormulas },
      () => Array(nMetrics).fill(0),
    );

    for (const entry of entries) {
      const scenarios = entry.result.scenarios;
      for (let mi = 0; mi < nMetrics; mi++) {
        const m = METRICS[mi];
        const vals = scenarios.map(
          (s) => m.extract(s.aggregated),
        );
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const range = max - min;

        for (let fi = 0; fi < nFormulas; fi++) {
          let norm: number;
          if (range === 0) {
            norm = 100;
          } else {
            const raw =
              (vals[fi] - min) / range;
            norm =
              m.direction === 'higher-better'
                ? 1 + raw * 99
                : 100 - raw * 99;
          }
          scores[fi][mi] += norm / entries.length;
        }
      }
    }

    const axisLabels = METRICS.map(
      (m) => m.radarLabel,
    );

    return formulaNames.map((name, fi) => {
      const values = [...scores[fi], scores[fi][0]];
      const labels = [
        ...axisLabels,
        axisLabels[0],
      ];
      return {
        type: 'scatterpolar' as const,
        name: truncName(name),
        r: values,
        theta: labels,
        fill: 'toself' as const,
        fillcolor: colorOf(fi) + '20',
        line: { color: colorOf(fi), width: 2 },
        marker: { size: 4 },
        hovertemplate:
          `<b>${truncName(name)}</b><br>` +
          '%{theta}: %{r:.1f}' +
          '<extra></extra>',
      };
    });
  }, [entries, formulaNames]);

  const radarLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 380,
    margin: { t: 32, r: 60, b: 32, l: 60 },
    polar: {
      radialaxis: {
        visible: true,
        range: [0, 105],
        tickvals: [0, 25, 50, 75, 100],
        gridcolor: '#e8e8e8',
      },
      angularaxis: {
        gridcolor: '#e8e8e8',
        linecolor: '#ccc',
      },
    },
    legend: {
      orientation: 'h',
      y: -0.1,
      x: 0.5,
      xanchor: 'center',
      font: { size: 11 },
    },
    showlegend: true,
  };

  // ──────────────────────────────────────────────────────
  // 2. Grouped Bar Charts per Metric
  //    X = workload scenarios, bars = formulas
  // ──────────────────────────────────────────────────────
  const groupedBarData = useMemo(() => {
    return METRICS.map((m) => {
      const traces = formulaNames.map(
        (fname, fi) => {
          const y = entries.map((e) => {
            const scenario =
              e.result.scenarios[fi];
            if (!scenario) return 0;
            return m.extract(scenario.aggregated);
          });

          // For time metrics, convert to hours
          const isTime =
            m.key === 'meanWaitTime' ||
            m.key === 'p95WaitTime';
          const yDisplay = isTime
            ? y.map((v) => v / 3600)
            : y;

          return {
            type: 'bar' as const,
            name: truncName(fname),
            x: scenarioNames.map(
              (n) => truncName(n, 24),
            ),
            y: yDisplay,
            marker: {
              color: colorOf(fi),
              cornerradius: 3,
            },
            hovertemplate:
              `<b>${truncName(fname)}</b><br>` +
              'Scenario: %{x}<br>' +
              `${m.label}: ` +
              (isTime
                ? '%{y:.3f} h'
                : m.key === 'jainsIndex'
                  ? '%{y:.4f}'
                  : '%{y:.3f}') +
              '<extra></extra>',
          };
        },
      );

      const isTime =
        m.key === 'meanWaitTime' ||
        m.key === 'p95WaitTime';

      const layout: Partial<Plotly.Layout> = {
        ...SHARED_LAYOUT,
        height: 280,
        barmode: 'group',
        legend: {
          orientation: 'h',
          y: -0.3,
          x: 0.5,
          xanchor: 'center',
          font: { size: 10 },
        },
        yaxis: {
          title: {
            text: isTime
              ? 'Hours'
              : m.unit || m.label,
            standoff: 8,
          },
          rangemode: 'tozero' as const,
          gridcolor: '#f0f0f0',
          ...(m.key === 'jainsIndex'
            ? { range: [0, 1.05], dtick: 0.2 }
            : {}),
        },
        xaxis: { tickfont: { size: 10 } },
        margin: {
          ...SHARED_LAYOUT.margin as object,
          b: 60,
        },
      };

      return { metric: m, traces, layout };
    });
  }, [entries, formulaNames, scenarioNames]);

  // ──────────────────────────────────────────────────────
  // 3. Win-Rate Stacked Horizontal Bar
  //    For each formula, % of scenarios where it was
  //    best (or tied for best) per metric.
  // ──────────────────────────────────────────────────────
  const winRateTraces = useMemo(() => {
    // Count wins per formula
    const wins: Record<string, number> = {};
    const ties: Record<string, number> = {};
    for (const fn of formulaNames) {
      wins[fn] = 0;
      ties[fn] = 0;
    }

    const totalContests =
      entries.length * METRICS.length;

    for (const entry of entries) {
      for (const m of METRICS) {
        const vals = entry.result.scenarios.map(
          (s) => m.extract(s.aggregated),
        );
        let bestVal = vals[0];
        for (let i = 1; i < vals.length; i++) {
          if (m.direction === 'higher-better') {
            if (vals[i] > bestVal)
              bestVal = vals[i];
          } else {
            if (vals[i] < bestVal)
              bestVal = vals[i];
          }
        }
        // Find winners (within 0.1% tolerance)
        const winners: number[] = [];
        for (let i = 0; i < vals.length; i++) {
          const rel =
            Math.abs(bestVal) > 1e-9
              ? Math.abs(vals[i] - bestVal) /
                Math.abs(bestVal)
              : Math.abs(vals[i] - bestVal);
          if (rel < 0.001) winners.push(i);
        }
        for (const wi of winners) {
          const fn = formulaNames[wi];
          if (winners.length === 1) {
            wins[fn]++;
          } else {
            ties[fn]++;
          }
        }
      }
    }

    const yLabels = formulaNames.map(
      (n) => truncName(n, 24),
    );

    return {
      traces: [
        {
          type: 'bar' as const,
          name: 'Solo Wins',
          orientation: 'h' as const,
          y: yLabels,
          x: formulaNames.map(
            (fn) =>
              (wins[fn] / totalContests) * 100,
          ),
          marker: { color: '#11A468' },
          hovertemplate:
            '<b>%{y}</b><br>' +
            'Solo wins: %{x:.1f}%' +
            '<extra></extra>',
        },
        {
          type: 'bar' as const,
          name: 'Tied Wins',
          orientation: 'h' as const,
          y: yLabels,
          x: formulaNames.map(
            (fn) =>
              (ties[fn] / totalContests) * 100,
          ),
          marker: { color: '#F59F00' },
          hovertemplate:
            '<b>%{y}</b><br>' +
            'Tied wins: %{x:.1f}%' +
            '<extra></extra>',
        },
      ],
      layout: {
        ...SHARED_LAYOUT,
        height: Math.max(
          160,
          60 + formulaNames.length * 40,
        ),
        barmode: 'stack' as const,
        xaxis: {
          title: {
            text: '% of contests',
            standoff: 8,
          },
          range: [0, 105],
          gridcolor: '#f0f0f0',
          dtick: 20,
        },
        yaxis: {
          automargin: true,
          tickfont: { size: 11 },
        },
        margin: { t: 8, r: 24, b: 40, l: 120 },
        legend: {
          orientation: 'h' as const,
          y: -0.3,
          x: 0.5,
          xanchor: 'center' as const,
          font: { size: 10 },
        },
      } as Partial<Plotly.Layout>,
    };
  }, [entries, formulaNames]);

  // ── Render ──────────────────────────────────────────────
  if (
    formulaNames.length === 0 ||
    entries.length === 0
  ) {
    return (
      <Text size="sm" c="dimmed">
        No cross-scenario data to chart.
      </Text>
    );
  }

  return (
    <Stack gap="lg">
      {/* 1. Meta Radar */}
      <ChartCard
        title="Cross-Scenario Radar Scorecard"
        subtitle={
          'Averaged normalised scores across all ' +
          'tested workload scenarios. Outer edge = ' +
          'best. Shows which formula is the most ' +
          'well-rounded generalist.'
        }
      >
        <Plot
          data={radarTraces as PlotParams["data"]}
          layout={radarLayout}
          config={PLOTLY_CONFIG as PlotParams["config"]}
          style={{ width: '100%' }}
        />
      </ChartCard>

      {/* 2. Grouped Bars per Metric */}
      {groupedBarData.map(
        ({ metric, traces, layout }) => (
          <ChartCard
            key={metric.key}
            title={`${metric.label} — by Scenario`}
            subtitle={
              `Compare each formula's ` +
              `${metric.label.toLowerCase()} ` +
              `across workload conditions. ` +
              (metric.direction === 'higher-better'
                ? 'Higher is better.'
                : 'Lower is better.')
            }
          >
            <Plot
              data={traces as PlotParams["data"]}
              layout={layout}
              config={PLOTLY_CONFIG as PlotParams["config"]}
              style={{ width: '100%' }}
            />
          </ChartCard>
        ),
      )}

      {/* 3. Win-Rate Stacked Bar */}
      <ChartCard
        title="Win Rate — Solo & Tied"
        subtitle={
          'Percentage of all metric×scenario ' +
          'contests where each formula achieved ' +
          'the best result (solo or tied).'
        }
      >
        <Plot
          data={winRateTraces.traces as PlotParams["data"]}
          layout={winRateTraces.layout}
          config={PLOTLY_CONFIG as PlotParams["config"]}
          style={{ width: '100%' }}
        />
      </ChartCard>
    </Stack>
  );
};
