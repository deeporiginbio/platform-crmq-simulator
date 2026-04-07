/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Badge, Button, Group, Menu, Stack, Text, Table, Tabs } from '@mantine/core';
import type { BenchmarkSuiteResult, ScenarioResult, ScenarioComparison, AggregatedMetrics, ConfidenceInterval, PairedTestResult, ScenarioPreset } from '@/lib/benchmark';
import { exportCSV, exportJSON, exportMarkdown } from '@/lib/benchmark';
import { ScenarioDetails } from '@/components/benchmark/scenario-details';
import { BenchmarkCharts } from '@/components/benchmark/benchmark-charts';

// ── Props ───────────────────────────────────────────────────────────────────

interface Props {
  result: BenchmarkSuiteResult;
  /** The scenario preset used for this benchmark (for showing workload details) */
  scenarioPreset?: ScenarioPreset;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (n: number, decimals = 2): string =>
  Number.isFinite(n) ? n.toFixed(decimals) : '—';

const fmtPct = (n: number): string =>
  Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';

const fmtCI = (ci: ConfidenceInterval): string =>
  `${fmt(ci.mean)} [${fmt(ci.low)} – ${fmt(ci.high)}]`;

const fmtCIPct = (ci: ConfidenceInterval): string =>
  `${fmtPct(ci.mean)} [${fmtPct(ci.low)} – ${fmtPct(ci.high)}]`;

const fmtTime = (sec: number): string => {
  if (sec < 60) return `${fmt(sec, 1)}s`;
  if (sec < 3600) return `${fmt(sec / 60, 1)}m`;
  return `${fmt(sec / 3600, 1)}h`;
};

const fmtCITime = (ci: ConfidenceInterval): string =>
  `${fmtTime(ci.mean)} [${fmtTime(ci.low)} – ${fmtTime(ci.high)}]`;

const sigBadge = (test: PairedTestResult) => {
  if (!test.significant) return <Badge size="xs" variant="outline" color="grey">ns</Badge>;
  // Deterministic workloads produce identical replications → d sentinel of 1e6.
  // Show "deterministic" instead of a meaningless giant number.
  if (test.cohensD >= 1e5) {
    return <Badge size="xs" variant="filled" color="blue">deterministic</Badge>;
  }
  const color = test.cohensD >= 0.8 ? 'red' : test.cohensD >= 0.5 ? 'yellow' : 'green';
  return <Badge size="xs" variant="filled" color={color}>{test.effectLabel} (d={fmt(test.cohensD)})</Badge>;
};

const winnerBadge = (winner: string, nameA: string, nameB: string) => {
  if (winner === 'tie') return <Badge size="xs" variant="outline" color="grey">Tie</Badge>;
  const color = winner === nameA ? 'indigo' : 'green';
  // Truncate long names
  const label = winner.length > 25 ? winner.slice(0, 22) + '...' : winner;
  return <Badge size="xs" variant="light" color={color}>{label}</Badge>;
};

// ── Component ───────────────────────────────────────────────────────────────

export const BenchmarkResults = ({ result, scenarioPreset }: Props) => {
  const duration = ((result.completedAt - result.startedAt) / 1000).toFixed(1);

  return (
    <Stack gap="md">
      {/* Summary header */}
      <Box p="sm" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8 }}>
        <Group gap="md" justify="space-between">
          <Box>
            <Group gap="md">
              <Text size="sm" fw={600} c="green.7">Benchmark Complete</Text>
              <Text size="xs" c="grey.6">
                {result.scenarios.length} formulas × {result.scenarios[0]?.aggregated.runs ?? 0} runs
                in {duration}s wall-clock
              </Text>
            </Group>
            {scenarioPreset && (
              <Group gap="xs" mt={4}>
                <Text size="xs" c="grey.6">Scenario:</Text>
                <Badge size="xs" variant="light" color="indigo">{scenarioPreset.name}</Badge>
                <Text size="xs" c="dimmed" lineClamp={1}>{scenarioPreset.description}</Text>
              </Group>
            )}
          </Box>
          <Menu shadow="md" width={180} position="bottom-end">
            <Menu.Target>
              <Button variant="light" size="xs" color="green">
                Export Results
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Download as</Menu.Label>
              <Menu.Item onClick={() => exportCSV(result, scenarioPreset)}>CSV</Menu.Item>
              <Menu.Item onClick={() => exportJSON(result, scenarioPreset)}>JSON</Menu.Item>
              <Menu.Item onClick={() => exportMarkdown(result, scenarioPreset)}>Markdown</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Box>

      <Tabs defaultValue="overview" variant="outline">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="charts">Charts</Tabs.Tab>
          <Tabs.Tab value="details">Per-Scenario Details</Tabs.Tab>
          {result.comparisons.length > 0 && (
            <Tabs.Tab value="comparison">Statistical Comparison</Tabs.Tab>
          )}
          {scenarioPreset && (
            <Tabs.Tab value="workload">Workload Details</Tabs.Tab>
          )}
        </Tabs.List>

        {/* ── Overview Tab ──────────────────────────────────────────────── */}
        <Tabs.Panel value="overview" pt="md">
          <OverviewTable scenarios={result.scenarios} />
        </Tabs.Panel>

        {/* ── Charts Tab ────────────────────────────────────────────────── */}
        <Tabs.Panel value="charts" pt="md">
          <BenchmarkCharts result={result} />
        </Tabs.Panel>

        {/* ── Details Tab ───────────────────────────────────────────────── */}
        <Tabs.Panel value="details" pt="md">
          <Stack gap="lg">
            {result.scenarios.map(s => (
              <ScenarioDetail key={s.scenarioId} scenario={s} />
            ))}
          </Stack>
        </Tabs.Panel>

        {/* ── Comparison Tab ────────────────────────────────────────────── */}
        {result.comparisons.length > 0 && (
          <Tabs.Panel value="comparison" pt="md">
            <Stack gap="lg">
              {result.comparisons.map((c, i) => (
                <ComparisonTable key={i} comparison={c} />
              ))}
            </Stack>
          </Tabs.Panel>
        )}

        {/* ── Workload Details Tab ─────────────────────────────────────── */}
        {scenarioPreset && (
          <Tabs.Panel value="workload" pt="md">
            <ScenarioDetails preset={scenarioPreset} defaultCollapsed={false} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  );
};

// ── Best/Worst Detection ─────────────────────────────────────────────────────

type Direction = 'higher-better' | 'lower-better';

/** Returns indices of the best and worst scenario for a given metric. */
const findBestWorst = (
  scenarios: ScenarioResult[],
  getValue: (a: AggregatedMetrics) => number,
  direction: Direction,
): { bestIdx: number; worstIdx: number } => {
  if (scenarios.length < 2) return { bestIdx: 0, worstIdx: 0 };
  const values = scenarios.map(s => getValue(s.aggregated));
  let bestIdx = 0;
  let worstIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (direction === 'higher-better') {
      if (values[i] > values[bestIdx]) bestIdx = i;
      if (values[i] < values[worstIdx]) worstIdx = i;
    } else {
      if (values[i] < values[bestIdx]) bestIdx = i;
      if (values[i] > values[worstIdx]) worstIdx = i;
    }
  }
  // Only mark if there's a meaningful difference (>1% relative)
  const range = Math.abs(values[bestIdx] - values[worstIdx]);
  const maxAbs = Math.max(Math.abs(values[bestIdx]), Math.abs(values[worstIdx]), 0.001);
  if (range / maxAbs < 0.01) return { bestIdx: -1, worstIdx: -1 };
  return { bestIdx, worstIdx };
};

// ── Overview Table ──────────────────────────────────────────────────────────

const OverviewTable = ({ scenarios }: { scenarios: ScenarioResult[] }) => (
  <Box style={{ overflowX: 'auto' }}>
    <Table striped highlightOnHover withTableBorder withColumnBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Metric</Table.Th>
          {scenarios.map(s => (
            <Table.Th key={s.scenarioId} style={{ minWidth: 200 }}>
              <Text size="xs" fw={600} lineClamp={2}>{s.scenarioName}</Text>
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        <MetricRow label="Throughput (jobs/min)" scenarios={scenarios} extract={a => fmtCI(a.throughput)} getValue={a => a.throughput.mean} direction="higher-better" />
        <MetricRow label="Mean Wait Time" scenarios={scenarios} extract={a => fmtCITime(a.meanWaitTime)} getValue={a => a.meanWaitTime.mean} direction="lower-better" />
        <MetricRow label="P50 Wait Time" scenarios={scenarios} extract={a => fmtCITime(a.p50WaitTime)} getValue={a => a.p50WaitTime.mean} direction="lower-better" />
        <MetricRow label="P95 Wait Time" scenarios={scenarios} extract={a => fmtCITime(a.p95WaitTime)} getValue={a => a.p95WaitTime.mean} direction="lower-better" />
        <MetricRow label="P99 Wait Time" scenarios={scenarios} extract={a => fmtCITime(a.p99WaitTime)} getValue={a => a.p99WaitTime.mean} direction="lower-better" />
        <MetricRow label="Max Wait Time" scenarios={scenarios} extract={a => fmtCITime(a.maxWaitTime)} getValue={a => a.maxWaitTime.mean} direction="lower-better" />
        <MetricRow label="Jain's Fairness Index" scenarios={scenarios} extract={a => fmtCI(a.jainsIndex)} getValue={a => a.jainsIndex.mean} direction="higher-better" highlight />
        <MetricRow label="Wait Time CoV" scenarios={scenarios} extract={a => fmtCI(a.coefficientOfVariation)} getValue={a => a.coefficientOfVariation.mean} direction="lower-better" />
      </Table.Tbody>
    </Table>
  </Box>
);

const MetricRow = ({
  label, scenarios, extract, getValue, direction, highlight,
}: {
  label: string;
  scenarios: ScenarioResult[];
  extract: (a: AggregatedMetrics) => string;
  getValue: (a: AggregatedMetrics) => number;
  direction: Direction;
  highlight?: boolean;
}) => {
  const { bestIdx, worstIdx } = findBestWorst(scenarios, getValue, direction);

  return (
    <Table.Tr style={highlight ? { background: '#FFFFF0' } : undefined}>
      <Table.Td>
        <Text size="xs" fw={500}>{label}</Text>
      </Table.Td>
      {scenarios.map((s, i) => {
        const isBest = i === bestIdx && bestIdx !== worstIdx;
        const isWorst = i === worstIdx && bestIdx !== worstIdx;
        return (
          <Table.Td
            key={s.scenarioId}
            style={isBest ? { background: '#F0FDF4' } : isWorst ? { background: '#FEF2F2' } : undefined}
          >
            <Group gap={6} wrap="nowrap">
              <Text size="xs" ff="monospace" fw={isBest || isWorst ? 600 : 400}>
                {extract(s.aggregated)}
              </Text>
              {isBest && <Badge size="xs" variant="light" color="green">Best</Badge>}
              {isWorst && <Badge size="xs" variant="light" color="red">Worst</Badge>}
            </Group>
          </Table.Td>
        );
      })}
    </Table.Tr>
  );
};

// ── Scenario Detail ─────────────────────────────────────────────────────────

const ScenarioDetail = ({ scenario }: { scenario: ScenarioResult }) => {
  const a = scenario.aggregated;
  const poolTypes = Object.keys(a.utilization);
  const orgIds = Object.keys(a.orgMetrics);

  return (
    <Box p="md" style={{ border: '1px solid #E5E7EA', borderRadius: 8 }}>
      <Stack gap="sm">
        <Group gap="sm">
          <Text fw={600} size="sm">{scenario.scenarioName}</Text>
          <Badge size="xs" variant="light" color="grey">{a.runs} runs</Badge>
        </Group>

        {/* Run stats */}
        <Text size="xs" c="dimmed">
          Avg sim duration: {fmtTime(scenario.runStats.reduce((a, r) => a + r.simDuration, 0) / scenario.runStats.length)}
          {' · '}Avg warm-up: {fmtTime(scenario.runStats.reduce((a, r) => a + r.warmUpTime, 0) / scenario.runStats.length)}
          {' · '}Avg events: {Math.round(scenario.runStats.reduce((a, r) => a + r.totalEvents, 0) / scenario.runStats.length).toLocaleString()}
        </Text>

        {/* Utilization per pool */}
        {poolTypes.length > 0 && (
          <Box>
            <Text size="xs" fw={500} c="grey.7" mb={4}>Utilization (95% CI)</Text>
            <Group gap="lg">
              {poolTypes.map(pt => (
                <Box key={pt}>
                  <Text size="xs" fw={500}>{pt}</Text>
                  <Text size="xs" ff="monospace" c="grey.6">
                    CPU: {fmtCIPct(a.utilization[pt].cpu)}{' · '}
                    GPU: {fmtCIPct(a.utilization[pt].gpu)}
                  </Text>
                </Box>
              ))}
            </Group>
          </Box>
        )}

        {/* Per-org breakdown */}
        {orgIds.length > 0 && (
          <Box>
            <Text size="xs" fw={500} c="grey.7" mb={4}>Per-Org (95% CI)</Text>
            <Table withTableBorder withColumnBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th><Text size="xs">Org</Text></Table.Th>
                  <Table.Th><Text size="xs">Mean Wait</Text></Table.Th>
                  <Table.Th><Text size="xs">Jobs Completed</Text></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {orgIds.map(orgId => (
                  <Table.Tr key={orgId}>
                    <Table.Td><Text size="xs">{orgId}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{fmtCITime(a.orgMetrics[orgId].meanWaitTime)}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{fmtCI(a.orgMetrics[orgId].jobsCompleted)}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Stack>
    </Box>
  );
};

// ── Comparison Table ────────────────────────────────────────────────────────

const ComparisonTable = ({ comparison: c }: { comparison: ScenarioComparison }) => (
  <Box p="md" style={{ border: '1px solid #E5E7EA', borderRadius: 8 }}>
    <Stack gap="sm">
      <Text fw={600} size="sm">
        Paired Comparison: <Text span c="indigo.5">{truncName(c.nameA)}</Text> vs <Text span c="green.6">{truncName(c.nameB)}</Text>
      </Text>
      <Text size="xs" c="dimmed">
        Paired t-test (n={c.throughput.n}) with Cohen&apos;s d effect sizes
      </Text>

      <Table withTableBorder withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th><Text size="xs">Metric</Text></Table.Th>
            <Table.Th><Text size="xs">t-statistic</Text></Table.Th>
            <Table.Th><Text size="xs">p-value</Text></Table.Th>
            <Table.Th><Text size="xs">Effect Size</Text></Table.Th>
            <Table.Th><Text size="xs">Winner</Text></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <CompRow label="Throughput" test={c.throughput} winner={c.winners['throughput']} nameA={c.nameA} nameB={c.nameB} />
          <CompRow label="Mean Wait Time" test={c.meanWaitTime} winner={c.winners['meanWaitTime']} nameA={c.nameA} nameB={c.nameB} />
          <CompRow label="P95 Wait Time" test={c.p95WaitTime} winner={c.winners['p95WaitTime']} nameA={c.nameA} nameB={c.nameB} />
          <CompRow label="Jain's Fairness" test={c.jainsIndex} winner={c.winners['jainsIndex']} nameA={c.nameA} nameB={c.nameB} />

        </Table.Tbody>
      </Table>
    </Stack>
  </Box>
);

const CompRow = ({
  label, test, winner, nameA, nameB,
}: {
  label: string;
  test: PairedTestResult;
  winner: string;
  nameA: string;
  nameB: string;
}) => (
  <Table.Tr>
    <Table.Td><Text size="xs" fw={500}>{label}</Text></Table.Td>
    <Table.Td><Text size="xs" ff="monospace">{fmt(test.tStatistic, 3)}</Text></Table.Td>
    <Table.Td>
      <Text size="xs" ff="monospace" c={test.pValue < 0.05 ? 'red.6' : 'grey.6'}>
        {test.pValue < 0.001 ? '<0.001' : fmt(test.pValue, 4)}
      </Text>
    </Table.Td>
    <Table.Td>{sigBadge(test)}</Table.Td>
    <Table.Td>{winnerBadge(winner, nameA, nameB)}</Table.Td>
  </Table.Tr>
);

const truncName = (name: string) =>
  name.length > 30 ? name.slice(0, 27) + '...' : name;
