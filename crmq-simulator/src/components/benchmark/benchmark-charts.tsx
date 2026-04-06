/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Group, Stack, Text, Badge } from '@mantine/core';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ErrorBar,
} from 'recharts';
import type { BenchmarkSuiteResult, ScenarioResult, AggregatedMetrics, ConfidenceInterval } from '@/lib/benchmark';

// ── Constants ───────────────────────────────────────────────────────────────

const FORMULA_COLORS = [
  '#4A65DC', '#11A468', '#E8590C', '#9C36B5', '#2B8A3E', '#D6336C',
  '#1098AD', '#F59F00', '#495057', '#862E9C',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmtTime = (sec: number): string => {
  if (!Number.isFinite(sec)) return '—';
  if (Math.abs(sec) < 60) return `${sec.toFixed(1)}s`;
  if (Math.abs(sec) < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
};

const fmtPct = (n: number): string =>
  Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';

/** Truncate long formula names for axis labels */
const truncName = (name: string, max = 18): string =>
  name.length > max ? name.slice(0, max - 1) + '…' : name;

// ── Custom Tooltip ──────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label, formatter }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <Box p="xs" style={{ background: '#fff', border: '1px solid #E5E7EA', borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <Text size="xs" fw={600} mb={4}>{label}</Text>
      {payload.map((entry: any, i: number) => (
        <Group key={i} gap={6}>
          <Box style={{ width: 8, height: 8, borderRadius: 2, background: entry.color }} />
          <Text size="xs">{entry.name}: <Text span fw={600} ff="monospace">{formatter ? formatter(entry.value) : entry.value}</Text></Text>
        </Group>
      ))}
    </Box>
  );
};

// ── Chart Wrapper ───────────────────────────────────────────────────────────

const ChartCard = ({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) => (
  <Box p="md" style={{ border: '1px solid #E5E7EA', borderRadius: 8, background: '#fff' }}>
    <Text size="sm" fw={600} c="grey.8">{title}</Text>
    {subtitle && <Text size="xs" c="dimmed" mb="sm">{subtitle}</Text>}
    <Box mt="xs">{children}</Box>
  </Box>
);

// ── Data Preparation ────────────────────────────────────────────────────────

interface ChartDatum {
  name: string;
  [formulaName: string]: string | number;
}

const buildMetricData = (
  scenarios: ScenarioResult[],
  metrics: Array<{ key: string; label: string; getValue: (a: AggregatedMetrics) => number; getError?: (a: AggregatedMetrics) => [number, number] }>,
): { data: ChartDatum[]; names: string[] } => {
  const names = scenarios.map(s => s.scenarioName);
  const data = metrics.map(m => {
    const row: ChartDatum = { name: m.label };
    for (const s of scenarios) {
      row[s.scenarioName] = Number(m.getValue(s.aggregated).toFixed(3));
    }
    return row;
  });
  return { data, names };
};

// ── Main Component ──────────────────────────────────────────────────────────

interface Props {
  result: BenchmarkSuiteResult;
}

export const BenchmarkCharts = ({ result }: Props) => {
  const scenarios = result.scenarios;
  const names = scenarios.map(s => s.scenarioName);

  if (scenarios.length === 0) {
    return <Text size="sm" c="dimmed">No scenario data to chart.</Text>;
  }

  // ── Wait Time Charts (in hours) ──────────────────────────────────────────

  const waitTimeData: ChartDatum[] = [
    { name: 'Mean', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number((s.aggregated.meanWaitTime.mean / 3600).toFixed(3))])) },
    { name: 'P50', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number((s.aggregated.p50WaitTime.mean / 3600).toFixed(3))])) },
    { name: 'P95', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number((s.aggregated.p95WaitTime.mean / 3600).toFixed(3))])) },
    { name: 'P99', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number((s.aggregated.p99WaitTime.mean / 3600).toFixed(3))])) },
    { name: 'Max', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number((s.aggregated.maxWaitTime.mean / 3600).toFixed(3))])) },
  ];

  // ── Throughput & Efficiency ──────────────────────────────────────────────

  const throughputData: ChartDatum[] = scenarios.map(s => ({
    name: truncName(s.scenarioName),
    fullName: s.scenarioName,
    value: Number(s.aggregated.throughput.mean.toFixed(3)),
    low: Number(s.aggregated.throughput.low.toFixed(3)),
    high: Number(s.aggregated.throughput.high.toFixed(3)),
  }));

  // ── Fairness & Quality ──────────────────────────────────────────────────

  const qualityData: ChartDatum[] = [
    { name: "Jain's FI", ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number(s.aggregated.jainsIndex.mean.toFixed(3))])) },
    { name: 'Eviction %', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number((s.aggregated.evictionRate.mean * 100).toFixed(2))])) },
    { name: 'Wait CoV', ...Object.fromEntries(scenarios.map(s => [s.scenarioName, Number(s.aggregated.coefficientOfVariation.mean.toFixed(3))])) },
  ];

  // ── Per-Org Wait Times ──────────────────────────────────────────────────

  const orgIds = scenarios.length > 0 ? Object.keys(scenarios[0].aggregated.orgMetrics) : [];
  const orgWaitData: ChartDatum[] = orgIds.map(orgId => ({
    name: orgId,
    ...Object.fromEntries(scenarios.map(s => [
      s.scenarioName,
      Number(((s.aggregated.orgMetrics[orgId]?.meanWaitTime.mean ?? 0) / 3600).toFixed(3)),
    ])),
  }));

  // ── Utilization ──────────────────────────────────────────────────────────

  const poolTypes = scenarios.length > 0 ? Object.keys(scenarios[0].aggregated.utilization) : [];
  const utilData: ChartDatum[] = poolTypes.flatMap(pt => [
    {
      name: `${pt} CPU`,
      ...Object.fromEntries(scenarios.map(s => [
        s.scenarioName,
        Number((s.aggregated.utilization[pt].cpu.mean * 100).toFixed(1)),
      ])),
    },
    ...(scenarios.some(s => s.aggregated.utilization[pt].gpu.mean > 0) ? [{
      name: `${pt} GPU`,
      ...Object.fromEntries(scenarios.map(s => [
        s.scenarioName,
        Number((s.aggregated.utilization[pt].gpu.mean * 100).toFixed(1)),
      ])),
    }] : []),
  ]);

  return (
    <Stack gap="lg">
      {/* Wait Times */}
      <ChartCard
        title="Wait Times by Formula"
        subtitle="Mean, P50, P95, P99, and Max wait times (hours). Lower is better."
      >
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={waitTimeData} barCategoryGap="15%">
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} unit="h" />
            <Tooltip content={<CustomTooltip formatter={(v: number) => `${v.toFixed(2)}h`} />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {names.map((name, i) => (
              <Bar key={name} dataKey={name} fill={FORMULA_COLORS[i % FORMULA_COLORS.length]} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <Group grow align="stretch" gap="md">
        {/* Throughput */}
        <ChartCard
          title="Throughput"
          subtitle="Jobs per minute with 95% CI. Higher is better."
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={throughputData} barCategoryGap="25%">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
              <Tooltip content={<CustomTooltip formatter={(v: number) => `${v.toFixed(3)} jobs/min`} />} />
              {(() => {
                // Single bar per scenario since each scenario IS a formula
                return <Bar dataKey="value" fill={FORMULA_COLORS[0]} radius={[3, 3, 0, 0]}>
                  {throughputData.map((_entry, i) => (
                    <rect key={i} fill={FORMULA_COLORS[i % FORMULA_COLORS.length]} />
                  ))}
                </Bar>;
              })()}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Quality Metrics */}
        <ChartCard
          title="Quality Metrics"
          subtitle="Jain's Fairness Index, Eviction Rate (%), Wait CoV"
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={qualityData} barCategoryGap="15%">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip content={<CustomTooltip formatter={(v: number) => v.toFixed(3)} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {names.map((name, i) => (
                <Bar key={name} dataKey={name} fill={FORMULA_COLORS[i % FORMULA_COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Group>

      {/* Per-Org Wait Times */}
      {orgWaitData.length > 0 && (
        <ChartCard
          title="Per-Org Mean Wait Time"
          subtitle="How each formula treats different organizations (hours). Reveals fairness vs. efficiency trade-offs."
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={orgWaitData} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} unit="h" />
              <Tooltip content={<CustomTooltip formatter={(v: number) => `${v.toFixed(2)}h`} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {names.map((name, i) => (
                <Bar key={name} dataKey={name} fill={FORMULA_COLORS[i % FORMULA_COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Utilization */}
      {utilData.length > 0 && (
        <ChartCard
          title="Cluster Utilization"
          subtitle="CPU and GPU utilization per pool (%). Higher indicates the formula keeps the cluster busier."
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={utilData} barCategoryGap="15%">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} />
              <Tooltip content={<CustomTooltip formatter={(v: number) => `${v.toFixed(1)}%`} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {names.map((name, i) => (
                <Bar key={name} dataKey={name} fill={FORMULA_COLORS[i % FORMULA_COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </Stack>
  );
};
