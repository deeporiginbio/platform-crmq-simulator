/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

/**
 * Multi-Scenario Results — Option C Layout
 * ==========================================
 * Per-scenario tabs + a cross-scenario summary tab
 * showing which formula wins across all scenarios.
 */

import {
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
} from '@mantine/core';
import type { MultiScenarioEntry } from
  '@/lib/benchmark-store';
import type {
  AggregatedMetrics,
  BenchmarkSuiteResult,
  ConfidenceInterval,
  PairedTestResult,
  ScenarioComparison,
  ScenarioPreset,
  ScenarioResult,
} from '@/lib/benchmark';
import {
  exportCSV,
  exportJSON,
  exportMarkdown,
  exportPDFReport,
  exportMarkdownReport,
  exportJSONReport,
  exportCSVReport,
} from '@/lib/benchmark';
import { BenchmarkCharts } from
  './benchmark-charts';
import { CrossScenarioCharts } from
  './cross-scenario-charts';
import { ScenarioDetails } from
  './scenario-details';

// ── Props ──────────────────────────────────────────────────────────

interface Props {
  entries: MultiScenarioEntry[];
}

// ── Helpers ────────────────────────────────────────────────────────

const fmt = (n: number, decimals = 2): string =>
  Number.isFinite(n) ? n.toFixed(decimals) : '—';

const fmtPct = (n: number): string =>
  Number.isFinite(n)
    ? `${(n * 100).toFixed(1)}%`
    : '—';

const fmtCI = (ci: ConfidenceInterval): string =>
  `${fmt(ci.mean)} [${fmt(ci.low)} – ${fmt(ci.high)}]`;

const fmtTime = (sec: number): string => {
  if (sec < 60) return `${fmt(sec, 1)}s`;
  if (sec < 3600) return `${fmt(sec / 60, 1)}m`;
  return `${fmt(sec / 3600, 1)}h`;
};

const fmtCITime = (
  ci: ConfidenceInterval,
): string =>
  `${fmtTime(ci.mean)} ` +
  `[${fmtTime(ci.low)} – ${fmtTime(ci.high)}]`;

const fmtCIPct = (
  ci: ConfidenceInterval,
): string =>
  `${fmtPct(ci.mean)} ` +
  `[${fmtPct(ci.low)} – ${fmtPct(ci.high)}]`;

const sigBadge = (test: PairedTestResult) => {
  if (!test.significant) {
    return (
      <Badge
        size="xs"
        variant="outline"
        color="grey"
      >
        ns
      </Badge>
    );
  }
  if (test.cohensD >= 1e5) {
    return (
      <Badge
        size="xs"
        variant="filled"
        color="blue"
      >
        deterministic
      </Badge>
    );
  }
  const color =
    test.cohensD >= 0.8
      ? 'red'
      : test.cohensD >= 0.5
        ? 'yellow'
        : 'green';
  return (
    <Badge size="xs" variant="filled" color={color}>
      {test.effectLabel} (d={fmt(test.cohensD)})
    </Badge>
  );
};

const truncName = (name: string) =>
  name.length > 30
    ? name.slice(0, 27) + '...'
    : name;

// ── Phase badge helper ─────────────────────────────────────────────

const phaseMeta: Record<
  number,
  { label: string; color: string }
> = {
  1: { label: 'Core', color: 'blue' },
  2: { label: 'Advanced', color: 'violet' },
  4: { label: 'Stress', color: 'red' },
  5: { label: 'Realistic', color: 'teal' },
  6: { label: 'Adversarial', color: 'pink' },
};

// ── Main Component ─────────────────────────────────────────────────

export const MultiScenarioResults = (
  { entries }: Props,
) => {
  const totalWallMs = entries.reduce(
    (acc, e) =>
      acc +
      (e.result.completedAt - e.result.startedAt),
    0,
  );
  const totalRuns = entries.reduce(
    (acc, e) =>
      acc +
      e.result.scenarios.length *
        (e.result.scenarios[0]?.aggregated.runs ??
          0),
    0,
  );

  return (
    <Stack gap="md">
      {/* Header */}
      <Box
        p="sm"
        style={{
          background: '#F0FDF4',
          border: '1px solid #BBF7D0',
          borderRadius: 8,
        }}
      >
        <Group gap="md" justify="space-between">
          <Box>
            <Group gap="md">
              <Text
                size="sm"
                fw={600}
                c="green.7"
              >
                Multi-Scenario Benchmark Complete
              </Text>
              <Text size="xs" c="grey.6">
                {entries.length} scenarios ×{' '}
                {entries[0]?.result.scenarios
                  .length ?? 0}{' '}
                formulas — {totalRuns} total runs in{' '}
                {(totalWallMs / 1000).toFixed(1)}s
              </Text>
            </Group>
            <Group gap="xs" mt={4} wrap="wrap">
              {entries.map((e) => {
                const pm =
                  phaseMeta[e.preset.phase];
                return (
                  <Badge
                    key={e.preset.id}
                    size="xs"
                    variant="light"
                    color={pm?.color ?? 'grey'}
                  >
                    {e.preset.name}
                  </Badge>
                );
              })}
            </Group>
          </Box>
          <MultiExportMenu entries={entries} />
        </Group>
      </Box>

      {/* Tabs: Summary + per-scenario */}
      <Tabs defaultValue="summary" variant="outline">
        <Tabs.List>
          <Tabs.Tab
            value="summary"
            leftSection={
              <Text size="xs">🏆</Text>
            }
          >
            Cross-Scenario Summary
          </Tabs.Tab>
          {entries.map((e) => (
            <Tabs.Tab
              key={e.preset.id}
              value={e.preset.id}
            >
              {e.preset.name}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        {/* ── Summary Tab ──────────────────────── */}
        <Tabs.Panel value="summary" pt="md">
          <CrossScenarioSummary entries={entries} />
        </Tabs.Panel>

        {/* ── Per-Scenario Tabs ────────────────── */}
        {entries.map((e) => (
          <Tabs.Panel
            key={e.preset.id}
            value={e.preset.id}
            pt="md"
          >
            <SingleScenarioView entry={e} />
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  );
};

// ── Multi-Export Menu ───────────────────────────────────────────────

const MultiExportMenu = (
  { entries }: {
    entries: MultiScenarioEntry[];
  },
) => (
  <Menu
    shadow="md"
    width={280}
    position="bottom-end"
  >
    <Menu.Target>
      <Button
        variant="light"
        size="xs"
        color="green"
      >
        Export Report
      </Button>
    </Menu.Target>
    <Menu.Dropdown>
      <Menu.Label>
        Consolidated Report
      </Menu.Label>
      <Menu.Item
        onClick={() =>
          exportPDFReport(entries)
        }
      >
        PDF Report (with charts)
      </Menu.Item>
      <Menu.Item
        onClick={() =>
          exportMarkdownReport(entries)
        }
      >
        Markdown Report
      </Menu.Item>
      <Menu.Divider />
      <Menu.Label>Data Export</Menu.Label>
      <Menu.Item
        onClick={() =>
          exportJSONReport(entries)
        }
      >
        JSON
      </Menu.Item>
      <Menu.Item
        onClick={() =>
          exportCSVReport(entries)
        }
      >
        CSV
      </Menu.Item>
    </Menu.Dropdown>
  </Menu>
);

// ── Cross-Scenario Summary ─────────────────────────────────────────

type MetricKey =
  | 'throughput'
  | 'meanWaitTime'
  | 'p95WaitTime'
  | 'jainsIndex';

interface MetricDef {
  key: MetricKey;
  label: string;
  direction: 'higher-better' | 'lower-better';
  extract: (a: AggregatedMetrics) => number;
  format: (a: AggregatedMetrics) => string;
}

const METRICS: MetricDef[] = [
  {
    key: 'throughput',
    label: 'Throughput (jobs/min)',
    direction: 'higher-better',
    extract: (a) => a.throughput.mean,
    format: (a) => fmt(a.throughput.mean),
  },
  {
    key: 'meanWaitTime',
    label: 'Mean Wait Time',
    direction: 'lower-better',
    extract: (a) => a.meanWaitTime.mean,
    format: (a) => fmtTime(a.meanWaitTime.mean),
  },
  {
    key: 'p95WaitTime',
    label: 'P95 Wait Time',
    direction: 'lower-better',
    extract: (a) => a.p95WaitTime.mean,
    format: (a) => fmtTime(a.p95WaitTime.mean),
  },
  {
    key: 'jainsIndex',
    label: "Jain's Fairness Index",
    direction: 'higher-better',
    extract: (a) => a.jainsIndex.mean,
    format: (a) => fmt(a.jainsIndex.mean, 4),
  },
];

/**
 * For each metric, find which formula wins in each
 * scenario, then tally wins across scenarios.
 */
const CrossScenarioSummary = (
  { entries }: { entries: MultiScenarioEntry[] },
) => {
  // Get formula names from first entry
  const formulaNames =
    entries[0]?.result.scenarios.map(
      (s) => s.scenarioName,
    ) ?? [];

  // Build win tally: metric → formula → win count
  const winTally: Record<
    string,
    Record<string, number>
  > = {};
  for (const m of METRICS) {
    winTally[m.key] = {};
    for (const fn of formulaNames) {
      winTally[m.key][fn] = 0;
    }
  }

  // Overall wins
  const overallWins: Record<string, number> = {};
  for (const fn of formulaNames) {
    overallWins[fn] = 0;
  }

  // Scenario × Metric → winners (plural — ties)
  const scenarioWinners: Record<
    string,
    Record<string, string[]>
  > = {};

  for (const entry of entries) {
    scenarioWinners[entry.preset.id] = {};
    for (const m of METRICS) {
      const vals = entry.result.scenarios.map(
        (s) => m.extract(s.aggregated),
      );
      // Find the best value
      let bestVal = vals[0];
      for (let i = 1; i < vals.length; i++) {
        if (m.direction === 'higher-better') {
          if (vals[i] > bestVal) bestVal = vals[i];
        } else {
          if (vals[i] < bestVal) bestVal = vals[i];
        }
      }
      // Collect ALL formulas that match the best
      // (within 0.1% relative tolerance for
      // floating-point equivalence)
      const winners: string[] = [];
      for (let i = 0; i < vals.length; i++) {
        const rel =
          Math.abs(bestVal) > 1e-9
            ? Math.abs(vals[i] - bestVal) /
              Math.abs(bestVal)
            : Math.abs(vals[i] - bestVal);
        if (rel < 0.001) {
          winners.push(formulaNames[i]);
        }
      }
      scenarioWinners[entry.preset.id][m.key] =
        winners;
      for (const w of winners) {
        winTally[m.key][w] =
          (winTally[m.key][w] ?? 0) + 1;
        overallWins[w] =
          (overallWins[w] ?? 0) + 1;
      }
    }
  }

  // Find overall best formula(s) — handle ties
  const sortedFormulas = [...formulaNames].sort(
    (a, b) =>
      (overallWins[b] ?? 0) -
      (overallWins[a] ?? 0),
  );
  const bestWins =
    overallWins[sortedFormulas[0]] ?? 0;
  const bestFormulas = sortedFormulas.filter(
    (fn) => (overallWins[fn] ?? 0) === bestWins,
  );
  const totalContests =
    entries.length * METRICS.length;

  return (
    <Stack gap="lg">
      {/* Overall winner card */}
      <Box
        p="md"
        style={{
          background:
            'linear-gradient(135deg, #667EEA11, #764BA211)',
          border: '1px solid #C4B5FD',
          borderRadius: 12,
        }}
      >
        <Group gap="md">
          <Text size="xl">🏆</Text>
          <Box>
            <Text size="sm" fw={600} c="violet.7">
              {bestFormulas.length > 1
                ? 'Tied for Best Overall'
                : 'Best Overall Formula'}
            </Text>
            <Group gap="xs" wrap="wrap">
              {bestFormulas.map((fn) => (
                <Text
                  key={fn}
                  size="lg"
                  fw={700}
                >
                  {fn}
                  {bestFormulas.length > 1 &&
                    fn !==
                      bestFormulas[
                        bestFormulas.length - 1
                      ] &&
                    ' ·'}
                </Text>
              ))}
            </Group>
            <Text size="xs" c="dimmed">
              {bestFormulas.length > 1
                ? `Each won ${bestWins}/${totalContests} metric contests across ${entries.length} scenarios`
                : `Won ${bestWins}/${totalContests} metric contests across ${entries.length} scenarios`}
            </Text>
          </Box>
        </Group>
      </Box>

      {/* Formula ranking */}
      <Box>
        <Text size="sm" fw={600} c="grey.8" mb="sm">
          Formula Rankings (by total wins)
        </Text>
        <Group gap="md" wrap="wrap">
          {sortedFormulas.map((fn, i) => {
            // Compute tied rank: find the first
            // index with the same win count
            const myWins =
              overallWins[fn] ?? 0;
            let rank = 1;
            for (
              let j = 0;
              j < i;
              j++
            ) {
              if (
                (overallWins[
                  sortedFormulas[j]
                ] ?? 0) > myWins
              ) {
                rank = j + 2;
              }
            }
            // Find how many share this rank
            const tied = sortedFormulas.filter(
              (f) =>
                (overallWins[f] ?? 0) ===
                myWins,
            ).length;
            const medal =
              rank === 1
                ? '🥇'
                : rank === 2
                  ? '🥈'
                  : rank === 3
                    ? '🥉'
                    : `#${rank}`;
            const isTop = rank === 1;
            return (
              <Box
                key={fn}
                p="sm"
                style={{
                  border: isTop
                    ? '2px solid #C4B5FD'
                    : '1px solid #E5E7EA',
                  borderRadius: 8,
                  minWidth: 150,
                  background: isTop
                    ? '#FFFFF0'
                    : '#fff',
                }}
              >
                <Group gap="xs">
                  <Text size="lg" fw={700}>
                    {medal}
                  </Text>
                  <Box>
                    <Group gap={4}>
                      <Text
                        size="xs"
                        fw={600}
                      >
                        {truncName(fn)}
                      </Text>
                      {tied > 1 && (
                        <Badge
                          size="xs"
                          variant="light"
                          color="yellow"
                        >
                          tied
                        </Badge>
                      )}
                    </Group>
                    <Text
                      size="xs"
                      c="dimmed"
                    >
                      {myWins}/{totalContests}{' '}
                      wins
                    </Text>
                  </Box>
                </Group>
              </Box>
            );
          })}
        </Group>
      </Box>

      {/* Win matrix: scenarios × metrics */}
      <Box>
        <Text size="sm" fw={600} c="grey.8" mb="sm">
          Winner Matrix — per scenario × metric
        </Text>
        <Box style={{ overflowX: 'auto' }}>
          <Table
            striped
            highlightOnHover
            withTableBorder
            withColumnBorders
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>
                  <Text size="xs">Scenario</Text>
                </Table.Th>
                {METRICS.map((m) => (
                  <Table.Th key={m.key}>
                    <Text size="xs">{m.label}</Text>
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((e) => (
                <Table.Tr key={e.preset.id}>
                  <Table.Td>
                    <Group gap={4}>
                      <Badge
                        size="xs"
                        variant="light"
                        color={
                          phaseMeta[e.preset.phase]
                            ?.color ?? 'grey'
                        }
                      >
                        {phaseMeta[e.preset.phase]
                          ?.label ?? '?'}
                      </Badge>
                      <Text size="xs" fw={500}>
                        {e.preset.name}
                      </Text>
                    </Group>
                  </Table.Td>
                  {METRICS.map((m) => {
                    const winners =
                      scenarioWinners[
                        e.preset.id
                      ]?.[m.key] ?? [];
                    const hasBest =
                      winners.some((w) =>
                        bestFormulas.includes(w),
                      );
                    return (
                      <Table.Td
                        key={m.key}
                        style={
                          hasBest
                            ? {
                                background:
                                  '#F0FDF4',
                              }
                            : undefined
                        }
                      >
                        <Stack gap={0}>
                          {winners.map((w) => (
                            <Group
                              key={w}
                              gap={4}
                              wrap="nowrap"
                            >
                              <Text
                                size="xs"
                                fw={
                                  bestFormulas.includes(
                                    w,
                                  )
                                    ? 600
                                    : 400
                                }
                              >
                                {truncName(w)}
                              </Text>
                              {winners.length >
                                1 && (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="yellow"
                                >
                                  tie
                                </Badge>
                              )}
                            </Group>
                          ))}
                        </Stack>
                      </Table.Td>
                    );
                  })}
                </Table.Tr>
              ))}
              {/* Totals row */}
              <Table.Tr
                style={{
                  background: '#F8F9FA',
                  fontWeight: 600,
                }}
              >
                <Table.Td>
                  <Text size="xs" fw={700}>
                    Total Wins
                  </Text>
                </Table.Td>
                {METRICS.map((m) => {
                  const metricWins =
                    winTally[m.key];
                  const sorted = Object.entries(
                    metricWins,
                  ).sort(
                    (a, b) => b[1] - a[1],
                  );
                  const topWins =
                    sorted[0]?.[1] ?? 0;
                  // All formulas tied at top
                  const topFormulas =
                    sorted.filter(
                      ([, w]) => w === topWins,
                    );
                  return (
                    <Table.Td key={m.key}>
                      <Stack gap={0}>
                        {topFormulas.map(
                          ([fn, w]) => (
                            <Group
                              key={fn}
                              gap={4}
                            >
                              <Text
                                size="xs"
                                fw={600}
                              >
                                {truncName(fn)}
                              </Text>
                              {topFormulas.length >
                                1 && (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="yellow"
                                >
                                  tie
                                </Badge>
                              )}
                            </Group>
                          ),
                        )}
                      </Stack>
                      <Text
                        size="xs"
                        c="dimmed"
                      >
                        {topWins}/{entries.length}
                      </Text>
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Box>
      </Box>

      {/* Cross-scenario comparison charts */}
      <CrossScenarioCharts entries={entries} />

      {/* Per-metric detail: actual values */}
      <Box>
        <Text size="sm" fw={600} c="grey.8" mb="sm">
          Detailed Values — all scenarios × formulas
        </Text>
        {METRICS.map((m) => (
          <Box key={m.key} mb="md">
            <Text
              size="xs"
              fw={600}
              c="grey.7"
              mb={4}
            >
              {m.label}
              <Text span c="dimmed" ml={4}>
                (
                {m.direction === 'higher-better'
                  ? '↑ higher is better'
                  : '↓ lower is better'}
                )
              </Text>
            </Text>
            <Box style={{ overflowX: 'auto' }}>
              <Table
                withTableBorder
                withColumnBorders
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>
                      <Text size="xs">
                        Scenario
                      </Text>
                    </Table.Th>
                    {formulaNames.map((fn) => (
                      <Table.Th
                        key={fn}
                        style={{ minWidth: 120 }}
                      >
                        <Text size="xs" fw={600}>
                          {truncName(fn)}
                        </Text>
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {entries.map((e) => {
                    const vals =
                      e.result.scenarios.map(
                        (s) =>
                          m.extract(s.aggregated),
                      );
                    // Find best value
                    let bestVal = vals[0];
                    for (
                      let i = 1;
                      i < vals.length;
                      i++
                    ) {
                      if (
                        m.direction ===
                        'higher-better'
                      ) {
                        if (vals[i] > bestVal)
                          bestVal = vals[i];
                      } else {
                        if (vals[i] < bestVal)
                          bestVal = vals[i];
                      }
                    }
                    // Find all tied winners
                    const bestIndices: number[] =
                      [];
                    for (
                      let i = 0;
                      i < vals.length;
                      i++
                    ) {
                      const rel =
                        Math.abs(bestVal) > 1e-9
                          ? Math.abs(
                              vals[i] - bestVal,
                            ) /
                            Math.abs(bestVal)
                          : Math.abs(
                              vals[i] - bestVal,
                            );
                      if (rel < 0.001) {
                        bestIndices.push(i);
                      }
                    }
                    const isTied =
                      bestIndices.length > 1;
                    return (
                      <Table.Tr
                        key={e.preset.id}
                      >
                        <Table.Td>
                          <Text
                            size="xs"
                            fw={500}
                          >
                            {e.preset.name}
                          </Text>
                        </Table.Td>
                        {e.result.scenarios.map(
                          (s, i) => {
                            const isBest =
                              bestIndices.includes(
                                i,
                              );
                            return (
                            <Table.Td
                              key={s.scenarioId}
                              style={
                                isBest
                                  ? {
                                      background:
                                        '#F0FDF4',
                                    }
                                  : undefined
                              }
                            >
                              <Group
                                gap={4}
                                wrap="nowrap"
                              >
                                <Text
                                  size="xs"
                                  ff="monospace"
                                  fw={
                                    isBest
                                      ? 600
                                      : 400
                                  }
                                >
                                  {m.format(
                                    s.aggregated,
                                  )}
                                </Text>
                                {isBest &&
                                  !isTied && (
                                  <Badge
                                    size="xs"
                                    variant="light"
                                    color="green"
                                  >
                                    Best
                                  </Badge>
                                )}
                                {isBest &&
                                  isTied && (
                                  <Badge
                                    size="xs"
                                    variant="light"
                                    color="yellow"
                                  >
                                    Tied
                                  </Badge>
                                )}
                              </Group>
                            </Table.Td>
                            );
                          },
                        )}
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Box>
          </Box>
        ))}
      </Box>
    </Stack>
  );
};

// ── Single Scenario View (used per tab) ────────────────────────────

const SingleScenarioView = (
  { entry }: { entry: MultiScenarioEntry },
) => {
  const { result, preset } = entry;
  const duration = (
    (result.completedAt - result.startedAt) /
    1000
  ).toFixed(1);

  return (
    <Stack gap="md">
      {/* Mini header */}
      <Box
        p="sm"
        style={{
          background: '#F8F9FA',
          borderRadius: 8,
          border: '1px solid #E5E7EA',
        }}
      >
        <Group justify="space-between">
          <Box>
            <Group gap="xs">
              <Badge
                size="sm"
                variant="light"
                color={
                  phaseMeta[preset.phase]?.color ??
                  'grey'
                }
              >
                {phaseMeta[preset.phase]?.label ??
                  '?'}
              </Badge>
              <Text size="sm" fw={600}>
                {preset.name}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" mt={2}>
              {preset.description} —{' '}
              {result.scenarios.length} formulas ×{' '}
              {result.scenarios[0]?.aggregated
                .runs ?? 0}{' '}
              runs in {duration}s
            </Text>
          </Box>
          <Menu
            shadow="md"
            width={180}
            position="bottom-end"
          >
            <Menu.Target>
              <Button
                variant="light"
                size="xs"
                color="green"
              >
                Export
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() =>
                  exportCSV(result, preset)
                }
              >
                CSV
              </Menu.Item>
              <Menu.Item
                onClick={() =>
                  exportJSON(result, preset)
                }
              >
                JSON
              </Menu.Item>
              <Menu.Item
                onClick={() =>
                  exportMarkdown(result, preset)
                }
              >
                Markdown
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Box>

      {/* Inner tabs */}
      <Tabs defaultValue="overview" variant="pills">
        <Tabs.List>
          <Tabs.Tab value="overview">
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="charts">Charts</Tabs.Tab>
          <Tabs.Tab value="details">
            Per-Formula Details
          </Tabs.Tab>
          {result.comparisons.length > 0 && (
            <Tabs.Tab value="comparison">
              Statistical Comparison
            </Tabs.Tab>
          )}
          <Tabs.Tab value="workload">
            Workload Details
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <OverviewTable
            scenarios={result.scenarios}
          />
        </Tabs.Panel>

        <Tabs.Panel value="charts" pt="md">
          <BenchmarkCharts result={result} />
        </Tabs.Panel>

        <Tabs.Panel value="details" pt="md">
          <Stack gap="lg">
            {result.scenarios.map((s) => (
              <FormulaDetail
                key={s.scenarioId}
                scenario={s}
              />
            ))}
          </Stack>
        </Tabs.Panel>

        {result.comparisons.length > 0 && (
          <Tabs.Panel value="comparison" pt="md">
            <Stack gap="lg">
              {result.comparisons.map((c, i) => (
                <ComparisonTable
                  key={i}
                  comparison={c}
                />
              ))}
            </Stack>
          </Tabs.Panel>
        )}

        <Tabs.Panel value="workload" pt="md">
          <ScenarioDetails
            preset={preset}
            defaultCollapsed={false}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
};

// ── Overview Table (reused) ────────────────────────────────────────

type Direction = 'higher-better' | 'lower-better';

const findBestWorst = (
  scenarios: ScenarioResult[],
  getValue: (a: AggregatedMetrics) => number,
  direction: Direction,
): { bestIdx: number; worstIdx: number } => {
  if (scenarios.length < 2) {
    return { bestIdx: 0, worstIdx: 0 };
  }
  const values = scenarios.map((s) =>
    getValue(s.aggregated),
  );
  let bestIdx = 0;
  let worstIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (direction === 'higher-better') {
      if (values[i] > values[bestIdx]) bestIdx = i;
      if (values[i] < values[worstIdx])
        worstIdx = i;
    } else {
      if (values[i] < values[bestIdx]) bestIdx = i;
      if (values[i] > values[worstIdx])
        worstIdx = i;
    }
  }
  const range = Math.abs(
    values[bestIdx] - values[worstIdx],
  );
  const maxAbs = Math.max(
    Math.abs(values[bestIdx]),
    Math.abs(values[worstIdx]),
    0.001,
  );
  if (range / maxAbs < 0.01) {
    return { bestIdx: -1, worstIdx: -1 };
  }
  return { bestIdx, worstIdx };
};

const OverviewTable = (
  { scenarios }: { scenarios: ScenarioResult[] },
) => (
  <Box style={{ overflowX: 'auto' }}>
    <Table
      striped
      highlightOnHover
      withTableBorder
      withColumnBorders
    >
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Metric</Table.Th>
          {scenarios.map((s) => (
            <Table.Th
              key={s.scenarioId}
              style={{ minWidth: 200 }}
            >
              <Text size="xs" fw={600} lineClamp={2}>
                {s.scenarioName}
              </Text>
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        <MRow
          label="Throughput (jobs/min)"
          scenarios={scenarios}
          extract={(a) => fmtCI(a.throughput)}
          getValue={(a) => a.throughput.mean}
          direction="higher-better"
        />
        <MRow
          label="Mean Wait Time"
          scenarios={scenarios}
          extract={(a) =>
            fmtCITime(a.meanWaitTime)
          }
          getValue={(a) => a.meanWaitTime.mean}
          direction="lower-better"
        />
        <MRow
          label="P50 Wait Time"
          scenarios={scenarios}
          extract={(a) =>
            fmtCITime(a.p50WaitTime)
          }
          getValue={(a) => a.p50WaitTime.mean}
          direction="lower-better"
        />
        <MRow
          label="P95 Wait Time"
          scenarios={scenarios}
          extract={(a) =>
            fmtCITime(a.p95WaitTime)
          }
          getValue={(a) => a.p95WaitTime.mean}
          direction="lower-better"
        />
        <MRow
          label="P99 Wait Time"
          scenarios={scenarios}
          extract={(a) =>
            fmtCITime(a.p99WaitTime)
          }
          getValue={(a) => a.p99WaitTime.mean}
          direction="lower-better"
        />
        <MRow
          label="Max Wait Time"
          scenarios={scenarios}
          extract={(a) =>
            fmtCITime(a.maxWaitTime)
          }
          getValue={(a) => a.maxWaitTime.mean}
          direction="lower-better"
        />
        <MRow
          label="Jain's Fairness Index"
          scenarios={scenarios}
          extract={(a) => fmtCI(a.jainsIndex)}
          getValue={(a) => a.jainsIndex.mean}
          direction="higher-better"
          highlight
        />
        <MRow
          label="Wait Time CoV"
          scenarios={scenarios}
          extract={(a) =>
            fmtCI(a.coefficientOfVariation)
          }
          getValue={(a) =>
            a.coefficientOfVariation.mean
          }
          direction="lower-better"
        />
      </Table.Tbody>
    </Table>
  </Box>
);

const MRow = ({
  label,
  scenarios,
  extract,
  getValue,
  direction,
  highlight,
}: {
  label: string;
  scenarios: ScenarioResult[];
  extract: (a: AggregatedMetrics) => string;
  getValue: (a: AggregatedMetrics) => number;
  direction: Direction;
  highlight?: boolean;
}) => {
  const { bestIdx, worstIdx } = findBestWorst(
    scenarios,
    getValue,
    direction,
  );
  return (
    <Table.Tr
      style={
        highlight
          ? { background: '#FFFFF0' }
          : undefined
      }
    >
      <Table.Td>
        <Text size="xs" fw={500}>
          {label}
        </Text>
      </Table.Td>
      {scenarios.map((s, i) => {
        const isBest =
          i === bestIdx && bestIdx !== worstIdx;
        const isWorst =
          i === worstIdx && bestIdx !== worstIdx;
        return (
          <Table.Td
            key={s.scenarioId}
            style={
              isBest
                ? { background: '#F0FDF4' }
                : isWorst
                  ? { background: '#FEF2F2' }
                  : undefined
            }
          >
            <Group gap={6} wrap="nowrap">
              <Text
                size="xs"
                ff="monospace"
                fw={
                  isBest || isWorst ? 600 : 400
                }
              >
                {extract(s.aggregated)}
              </Text>
              {isBest && (
                <Badge
                  size="xs"
                  variant="light"
                  color="green"
                >
                  Best
                </Badge>
              )}
              {isWorst && (
                <Badge
                  size="xs"
                  variant="light"
                  color="red"
                >
                  Worst
                </Badge>
              )}
            </Group>
          </Table.Td>
        );
      })}
    </Table.Tr>
  );
};

// ── Formula Detail ─────────────────────────────────────────────────

const FormulaDetail = (
  { scenario }: { scenario: ScenarioResult },
) => {
  const a = scenario.aggregated;
  const poolTypes = Object.keys(a.utilization);
  const orgIds = Object.keys(a.orgMetrics);

  return (
    <Box
      p="md"
      style={{
        border: '1px solid #E5E7EA',
        borderRadius: 8,
      }}
    >
      <Stack gap="sm">
        <Group gap="sm">
          <Text fw={600} size="sm">
            {scenario.scenarioName}
          </Text>
          <Badge
            size="xs"
            variant="light"
            color="grey"
          >
            {a.runs} runs
          </Badge>
        </Group>

        <Text size="xs" c="dimmed">
          Avg sim duration:{' '}
          {fmtTime(
            scenario.runStats.reduce(
              (acc, r) => acc + r.simDuration,
              0,
            ) / scenario.runStats.length,
          )}
          {' · '}Avg warm-up:{' '}
          {fmtTime(
            scenario.runStats.reduce(
              (acc, r) => acc + r.warmUpTime,
              0,
            ) / scenario.runStats.length,
          )}
          {' · '}Avg events:{' '}
          {Math.round(
            scenario.runStats.reduce(
              (acc, r) => acc + r.totalEvents,
              0,
            ) / scenario.runStats.length,
          ).toLocaleString()}
        </Text>

        {poolTypes.length > 0 && (
          <Box>
            <Text
              size="xs"
              fw={500}
              c="grey.7"
              mb={4}
            >
              Utilization (95% CI)
            </Text>
            <Group gap="lg">
              {poolTypes.map((pt) => (
                <Box key={pt}>
                  <Text size="xs" fw={500}>
                    {pt}
                  </Text>
                  <Text
                    size="xs"
                    ff="monospace"
                    c="grey.6"
                  >
                    CPU:{' '}
                    {fmtCIPct(
                      a.utilization[pt].cpu,
                    )}
                    {' · '}GPU:{' '}
                    {fmtCIPct(
                      a.utilization[pt].gpu,
                    )}
                  </Text>
                </Box>
              ))}
            </Group>
          </Box>
        )}

        {orgIds.length > 0 && (
          <Box>
            <Text
              size="xs"
              fw={500}
              c="grey.7"
              mb={4}
            >
              Per-Org (95% CI)
            </Text>
            <Table
              withTableBorder
              withColumnBorders
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>
                    <Text size="xs">Org</Text>
                  </Table.Th>
                  <Table.Th>
                    <Text size="xs">
                      Mean Wait
                    </Text>
                  </Table.Th>
                  <Table.Th>
                    <Text size="xs">
                      Jobs Completed
                    </Text>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {orgIds.map((orgId) => (
                  <Table.Tr key={orgId}>
                    <Table.Td>
                      <Text size="xs">
                        {orgId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text
                        size="xs"
                        ff="monospace"
                      >
                        {fmtCITime(
                          a.orgMetrics[orgId]
                            .meanWaitTime,
                        )}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text
                        size="xs"
                        ff="monospace"
                      >
                        {fmtCI(
                          a.orgMetrics[orgId]
                            .jobsCompleted,
                        )}
                      </Text>
                    </Table.Td>
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

// ── Comparison Table ───────────────────────────────────────────────

const ComparisonTable = (
  { comparison: c }: { comparison: ScenarioComparison },
) => {
  const winnerBadge = (
    winner: string,
    nameA: string,
    nameB: string,
  ) => {
    if (winner === 'tie') {
      return (
        <Badge
          size="xs"
          variant="outline"
          color="grey"
        >
          Tie
        </Badge>
      );
    }
    const color =
      winner === nameA ? 'indigo' : 'green';
    const label =
      winner.length > 25
        ? winner.slice(0, 22) + '...'
        : winner;
    return (
      <Badge
        size="xs"
        variant="light"
        color={color}
      >
        {label}
      </Badge>
    );
  };

  return (
    <Box
      p="md"
      style={{
        border: '1px solid #E5E7EA',
        borderRadius: 8,
      }}
    >
      <Stack gap="sm">
        <Text fw={600} size="sm">
          Paired Comparison:{' '}
          <Text span c="indigo.5">
            {truncName(c.nameA)}
          </Text>{' '}
          vs{' '}
          <Text span c="green.6">
            {truncName(c.nameB)}
          </Text>
        </Text>
        <Text size="xs" c="dimmed">
          Paired t-test (n={c.throughput.n}) with
          Cohen&apos;s d effect sizes
        </Text>

        <Table withTableBorder withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <Text size="xs">Metric</Text>
              </Table.Th>
              <Table.Th>
                <Text size="xs">t-statistic</Text>
              </Table.Th>
              <Table.Th>
                <Text size="xs">p-value</Text>
              </Table.Th>
              <Table.Th>
                <Text size="xs">Effect Size</Text>
              </Table.Th>
              <Table.Th>
                <Text size="xs">Winner</Text>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[
              {
                label: 'Throughput',
                test: c.throughput,
                winner: c.winners['throughput'],
              },
              {
                label: 'Mean Wait Time',
                test: c.meanWaitTime,
                winner: c.winners['meanWaitTime'],
              },
              {
                label: 'P95 Wait Time',
                test: c.p95WaitTime,
                winner: c.winners['p95WaitTime'],
              },
              {
                label: "Jain's Fairness",
                test: c.jainsIndex,
                winner: c.winners['jainsIndex'],
              },
            ].map((row) => (
              <Table.Tr key={row.label}>
                <Table.Td>
                  <Text size="xs" fw={500}>
                    {row.label}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace">
                    {fmt(row.test.tStatistic, 3)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text
                    size="xs"
                    ff="monospace"
                    c={
                      row.test.pValue < 0.05
                        ? 'red.6'
                        : 'grey.6'
                    }
                  >
                    {row.test.pValue < 0.001
                      ? '<0.001'
                      : fmt(row.test.pValue, 4)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {sigBadge(row.test)}
                </Table.Td>
                <Table.Td>
                  {winnerBadge(
                    row.winner,
                    c.nameA,
                    c.nameB,
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Box>
  );
};
