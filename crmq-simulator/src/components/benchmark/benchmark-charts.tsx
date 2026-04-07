/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useMemo } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import type {
  BenchmarkSuiteResult,
  ScenarioResult,
  AggregatedMetrics,
  ConfidenceInterval,
} from '@/lib/benchmark';
import {
  FORMULA_COLORS,
  colorOf,
  SHARED_LAYOUT,
  PLOTLY_CONFIG,
  truncName,
} from '@/lib/benchmark/chart-utils';

// ── Plotly component (tree-shaken) ─────────────────────────────
const Plot = createPlotlyComponent(Plotly);

const ciError = (
  scenarios: ScenarioResult[],
  getter: (a: AggregatedMetrics) => ConfidenceInterval,
  scale = 1,
): { low: number[]; high: number[] } => {
  const low: number[] = [];
  const high: number[] = [];
  for (const s of scenarios) {
    const ci = getter(s.aggregated);
    const mean = ci.mean * scale;
    low.push(Math.max(0, mean - ci.low * scale));
    high.push(ci.high * scale - mean);
  }
  return { low, high };
};

// ── Chart Wrapper ──────────────────────────────────────────────
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

// ── Main Component ─────────────────────────────────────────────
interface Props {
  result: BenchmarkSuiteResult;
}

export const BenchmarkCharts = ({ result }: Props) => {
  const scenarios = result.scenarios;
  const names = scenarios.map((s) => s.scenarioName);
  const shortNames = names.map((n) => truncName(n));

  if (scenarios.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No scenario data to chart.
      </Text>
    );
  }

  // ────────────────────────────────────────────────────────────
  // 1. Throughput with 95% CI error bars
  // ────────────────────────────────────────────────────────────
  const throughputTraces = useMemo(() => {
    return scenarios.map((s, i) => {
      const ci = s.aggregated.throughput;
      return {
        type: 'bar' as const,
        name: truncName(s.scenarioName),
        x: [truncName(s.scenarioName)],
        y: [ci.mean],
        error_y: {
          type: 'data' as const,
          symmetric: false,
          array: [ci.high - ci.mean],
          arrayminus: [ci.mean - ci.low],
          color: '#555',
          thickness: 1.5,
          width: 4,
        },
        marker: { color: colorOf(i), cornerradius: 3 },
        hovertemplate:
          `<b>${s.scenarioName}</b><br>` +
          'Throughput: %{y:.3f} jobs/min<br>' +
          `95% CI: [${ci.low.toFixed(3)}, ` +
          `${ci.high.toFixed(3)}]` +
          '<extra></extra>',
      };
    });
  }, [scenarios]);

  const throughputLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 260,
    showlegend: false,
    yaxis: {
      title: { text: 'Jobs / min', standoff: 8 },
      rangemode: 'tozero',
      gridcolor: '#f0f0f0',
    },
    xaxis: { tickfont: { size: 10 } },
  };

  // ────────────────────────────────────────────────────────────
  // 2a. Jain's Fairness Index (dedicated, domain [0,1])
  // ────────────────────────────────────────────────────────────
  const fairnessTraces = useMemo(() => {
    return scenarios.map((s, i) => {
      const ci = s.aggregated.jainsIndex;
      return {
        type: 'bar' as const,
        name: truncName(s.scenarioName),
        x: [truncName(s.scenarioName)],
        y: [ci.mean],
        error_y: {
          type: 'data' as const,
          symmetric: false,
          array: [Math.min(ci.high - ci.mean, 1 - ci.mean)],
          arrayminus: [Math.max(ci.mean - ci.low, 0)],
          color: '#555',
          thickness: 1.5,
          width: 4,
        },
        marker: { color: colorOf(i), cornerradius: 3 },
        hovertemplate:
          `<b>${s.scenarioName}</b><br>` +
          "Jain's FI: %{y:.4f}<br>" +
          `95% CI: [${ci.low.toFixed(4)}, ` +
          `${ci.high.toFixed(4)}]` +
          '<extra></extra>',
      };
    });
  }, [scenarios]);

  const fairnessLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 240,
    showlegend: false,
    yaxis: {
      title: { text: "Jain's Fairness Index", standoff: 8 },
      range: [0, 1.05],
      gridcolor: '#f0f0f0',
      dtick: 0.2,
    },
    xaxis: { tickfont: { size: 10 } },
  };

  // ────────────────────────────────────────────────────────────
  // 3a. Typical Wait Times (Mean & P50) — linear Y
  // ────────────────────────────────────────────────────────────
  const typicalWaitTraces = useMemo(() => {
    const metrics: Array<{
      label: string;
      get: (a: AggregatedMetrics) => ConfidenceInterval;
    }> = [
      { label: 'Mean', get: (a) => a.meanWaitTime },
      { label: 'P50', get: (a) => a.p50WaitTime },
    ];

    return scenarios.flatMap((s, i) =>
      metrics.map((m, mi) => {
        const ci = m.get(s.aggregated);
        const hrs = ci.mean / 3600;
        const lowHrs = ci.low / 3600;
        const highHrs = ci.high / 3600;
        return {
          type: 'bar' as const,
          name: truncName(s.scenarioName),
          x: [m.label],
          y: [hrs],
          error_y: {
            type: 'data' as const,
            symmetric: false,
            array: [highHrs - hrs],
            arrayminus: [hrs - lowHrs],
            color: '#555',
            thickness: 1.5,
            width: 3,
          },
          marker: {
            color: colorOf(i),
            cornerradius: 3,
          },
          legendgroup: s.scenarioName,
          showlegend: mi === 0,
          hovertemplate:
            `<b>${s.scenarioName}</b> — ${m.label}<br>` +
            '%{y:.3f} h<br>' +
            `95% CI: [${lowHrs.toFixed(3)}, ` +
            `${highHrs.toFixed(3)}] h` +
            '<extra></extra>',
        };
      }),
    );
  }, [scenarios]);

  const typicalWaitLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 260,
    barmode: 'group',
    legend: {
      orientation: 'h',
      y: -0.25,
      x: 0.5,
      xanchor: 'center',
      font: { size: 10 },
    },
    yaxis: {
      title: { text: 'Hours', standoff: 8 },
      rangemode: 'tozero',
      gridcolor: '#f0f0f0',
    },
  };

  // ────────────────────────────────────────────────────────────
  // 3b. Tail Wait Times (P95, P99, Max) — log Y
  // ────────────────────────────────────────────────────────────
  const tailWaitTraces = useMemo(() => {
    const metrics: Array<{
      label: string;
      get: (a: AggregatedMetrics) => ConfidenceInterval;
    }> = [
      { label: 'P95', get: (a) => a.p95WaitTime },
      { label: 'P99', get: (a) => a.p99WaitTime },
      { label: 'Max', get: (a) => a.maxWaitTime },
    ];

    return scenarios.flatMap((s, i) =>
      metrics.map((m, mi) => {
        const ci = m.get(s.aggregated);
        const hrs = ci.mean / 3600;
        return {
          type: 'bar' as const,
          name: truncName(s.scenarioName),
          x: [m.label],
          y: [hrs],
          marker: {
            color: colorOf(i),
            cornerradius: 3,
          },
          legendgroup: s.scenarioName,
          showlegend: mi === 0,
          hovertemplate:
            `<b>${s.scenarioName}</b> — ${m.label}<br>` +
            '%{y:.3f} h' +
            '<extra></extra>',
        };
      }),
    );
  }, [scenarios]);

  const tailWaitLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 260,
    barmode: 'group',
    legend: {
      orientation: 'h',
      y: -0.25,
      x: 0.5,
      xanchor: 'center',
      font: { size: 10 },
    },
    yaxis: {
      title: { text: 'Hours (log)', standoff: 8 },
      type: 'log',
      gridcolor: '#f0f0f0',
    },
  };

  // ────────────────────────────────────────────────────────────
  // 4. Radar / Spider Scorecard
  // ────────────────────────────────────────────────────────────
  const radarTraces = useMemo(() => {
    // Collect raw values per formula
    const raw = scenarios.map((s) => ({
      throughput: s.aggregated.throughput.mean,
      fairness: s.aggregated.jainsIndex.mean,
      meanWait: s.aggregated.meanWaitTime.mean,
      tailWait: s.aggregated.p95WaitTime.mean,
      utilCpu: (() => {
        const pools = Object.values(s.aggregated.utilization);
        if (pools.length === 0) return 0;
        return (
          pools.reduce((sum, p) => sum + p.cpu.mean, 0) /
          pools.length
        );
      })(),
    }));

    // Normalize each axis to [0, 1]
    // For "lower is better" metrics, invert after normalizing
    const keys = [
      'throughput',
      'fairness',
      'meanWait',
      'tailWait',
      'utilCpu',
    ] as const;
    const mins: Record<string, number> = {};
    const maxs: Record<string, number> = {};
    for (const k of keys) {
      const vals = raw.map(
        (r) => r[k as keyof (typeof raw)[0]],
      );
      mins[k] = Math.min(...vals);
      maxs[k] = Math.max(...vals);
    }

    const norm = (
      val: number,
      key: string,
      invert: boolean,
    ): number => {
      const range = maxs[key] - mins[key];
      if (range === 0) return 100;
      const n = (val - mins[key]) / range;
      const scaled = 1 + n * 99;
      return invert ? 101 - scaled : scaled;
    };

    const axisLabels = [
      'Throughput',
      'Fairness',
      'Mean Wait',
      'Tail Wait (P95)',
      'CPU Util',
    ];

    return scenarios.map((s, i) => {
      const r = raw[i];
      const values = [
        norm(r.throughput, 'throughput', false),
        norm(r.fairness, 'fairness', false),
        norm(r.meanWait, 'meanWait', true),
        norm(r.tailWait, 'tailWait', true),
        norm(r.utilCpu, 'utilCpu', false),
      ];
      // Close the polygon
      values.push(values[0]);
      const labels = [...axisLabels, axisLabels[0]];

      return {
        type: 'scatterpolar' as const,
        name: truncName(s.scenarioName),
        r: values,
        theta: labels,
        fill: 'toself' as const,
        fillcolor: colorOf(i) + '20',
        line: { color: colorOf(i), width: 2 },
        marker: { size: 4 },
        hovertemplate:
          `<b>${s.scenarioName}</b><br>` +
          '%{theta}: %{r:.1f}' +
          '<extra></extra>',
      };
    });
  }, [scenarios]);

  const radarLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 360,
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

  // ────────────────────────────────────────────────────────────
  // Existing charts migrated: Per-Org Wait, Utilization
  // ────────────────────────────────────────────────────────────
  const orgIds =
    scenarios.length > 0
      ? Object.keys(scenarios[0].aggregated.orgMetrics)
      : [];

  const orgWaitTraces = useMemo(() => {
    return scenarios.map((s, i) => ({
      type: 'bar' as const,
      name: truncName(s.scenarioName),
      x: orgIds,
      y: orgIds.map((id) =>
        Number(
          (
            (s.aggregated.orgMetrics[id]?.meanWaitTime
              .mean ?? 0) / 3600
          ).toFixed(3),
        ),
      ),
      marker: { color: colorOf(i), cornerradius: 3 },
      hovertemplate:
        `<b>${s.scenarioName}</b><br>` +
        'Org: %{x}<br>' +
        'Mean Wait: %{y:.3f} h' +
        '<extra></extra>',
    }));
  }, [scenarios, orgIds]);

  const orgWaitLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 280,
    barmode: 'group',
    legend: {
      orientation: 'h',
      y: -0.25,
      x: 0.5,
      xanchor: 'center',
      font: { size: 10 },
    },
    yaxis: {
      title: { text: 'Hours', standoff: 8 },
      rangemode: 'tozero',
      gridcolor: '#f0f0f0',
    },
    xaxis: { tickfont: { size: 10 } },
  };

  const poolTypes =
    scenarios.length > 0
      ? Object.keys(scenarios[0].aggregated.utilization)
      : [];

  const utilTraces = useMemo(() => {
    const categories: string[] = [];
    for (const pt of poolTypes) {
      categories.push(`${pt} CPU`);
      if (
        scenarios.some(
          (s) =>
            s.aggregated.utilization[pt].gpu.mean > 0,
        )
      ) {
        categories.push(`${pt} GPU`);
      }
    }

    return scenarios.map((s, i) => ({
      type: 'bar' as const,
      name: truncName(s.scenarioName),
      x: categories,
      y: categories.map((cat) => {
        const [pool, resource] = cat.split(' ');
        const key =
          resource.toLowerCase() as 'cpu' | 'gpu';
        return Number(
          (
            s.aggregated.utilization[pool][key].mean *
            100
          ).toFixed(1),
        );
      }),
      marker: { color: colorOf(i), cornerradius: 3 },
      hovertemplate:
        `<b>${s.scenarioName}</b><br>` +
        '%{x}: %{y:.1f}%' +
        '<extra></extra>',
    }));
  }, [scenarios, poolTypes]);

  const utilLayout: Partial<Plotly.Layout> = {
    ...SHARED_LAYOUT,
    height: 240,
    barmode: 'group',
    legend: {
      orientation: 'h',
      y: -0.3,
      x: 0.5,
      xanchor: 'center',
      font: { size: 10 },
    },
    yaxis: {
      title: { text: '%', standoff: 8 },
      range: [0, 105],
      gridcolor: '#f0f0f0',
    },
    xaxis: { tickfont: { size: 10 } },
  };

  // ── Render ───────────────────────────────────────────────────
  return (
    <Stack gap="lg">
      {/* 4. Radar Scorecard — top-level overview */}
      <ChartCard
        title="Formula Scorecard"
        subtitle={
          'Normalized comparison across key metrics. ' +
          'For wait times, lower raw values map to ' +
          'higher scores. Outer edge = best.'
        }
      >
        <Plot
          data={radarTraces as any}
          layout={radarLayout}
          config={PLOTLY_CONFIG}
          style={{ width: '100%' }}
        />
      </ChartCard>

      {/* 1. Throughput with error bars */}
      <ChartCard
        title="Throughput"
        subtitle={
          'Jobs per minute with 95% confidence ' +
          'intervals. Higher is better.'
        }
      >
        <Plot
          data={throughputTraces as any}
          layout={throughputLayout}
          config={PLOTLY_CONFIG}
          style={{ width: '100%' }}
        />
      </ChartCard>

      {/* 2. Jain's Fairness (dedicated, [0,1]) */}
      <Group grow align="stretch" gap="md">
        <ChartCard
          title="Jain's Fairness Index"
          subtitle={
            'Scale 0–1. Higher means more equitable ' +
            'resource distribution across orgs.'
          }
        >
          <Plot
            data={fairnessTraces as any}
            layout={fairnessLayout}
            config={PLOTLY_CONFIG}
            style={{ width: '100%' }}
          />
        </ChartCard>
      </Group>

      {/* 3. Split Wait Times */}
      <Group grow align="stretch" gap="md">
        <ChartCard
          title="Typical Wait (Mean & P50)"
          subtitle={
            'Average and median wait times in hours. ' +
            'Lower is better.'
          }
        >
          <Plot
            data={typicalWaitTraces as any}
            layout={typicalWaitLayout}
            config={PLOTLY_CONFIG}
            style={{ width: '100%' }}
          />
        </ChartCard>

        <ChartCard
          title="Tail Wait (P95 / P99 / Max)"
          subtitle={
            'Worst-case wait times on log scale. ' +
            'Lower is better.'
          }
        >
          <Plot
            data={tailWaitTraces as any}
            layout={tailWaitLayout}
            config={PLOTLY_CONFIG}
            style={{ width: '100%' }}
          />
        </ChartCard>
      </Group>

      {/* Per-Org Wait */}
      {orgIds.length > 0 && (
        <ChartCard
          title="Per-Org Mean Wait Time"
          subtitle={
            'How each formula treats different ' +
            'organizations (hours). Reveals fairness ' +
            'vs. efficiency trade-offs.'
          }
        >
          <Plot
            data={orgWaitTraces as any}
            layout={orgWaitLayout}
            config={PLOTLY_CONFIG}
            style={{ width: '100%' }}
          />
        </ChartCard>
      )}

      {/* Utilization */}
      {poolTypes.length > 0 && (
        <ChartCard
          title="Cluster Utilization"
          subtitle={
            'CPU and GPU utilization per pool (%). ' +
            'Higher = formula keeps cluster busier.'
          }
        >
          <Plot
            data={utilTraces as any}
            layout={utilLayout}
            config={PLOTLY_CONFIG}
            style={{ width: '100%' }}
          />
        </ChartCard>
      )}
    </Stack>
  );
};
