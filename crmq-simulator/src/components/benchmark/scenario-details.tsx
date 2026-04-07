/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Badge, Group, Stack, Text, Table, Collapse } from '@mantine/core';
import { useState } from 'react';
import type { ScenarioPreset } from '@/lib/benchmark';

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmtDuration = (sec: number): string => {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(0)}d`;
};

const fmtRate = (pattern: ScenarioPreset['workloadConfig']['arrivalPattern']): string => {
  switch (pattern.type) {
    case 'poisson':
      return `Poisson — ${pattern.lambdaPerMinute} jobs/min`;
    case 'uniform':
      return `Uniform — ${pattern.ratePerMinute} jobs/min`;
    case 'burst':
      return `Burst — ${pattern.count} jobs at t=${pattern.atTime}s`;
    case 'mmpp':
      return `MMPP — ${pattern.states.map(s => `${s.label}: ${s.lambdaPerMinute}/min`).join(', ')}`;
    case 'periodic_mix':
      return `Periodic Mix — ${pattern.templates.length} job templates`;
    default:
      return 'Unknown';
  }
};

const fmtSize = (dist: ScenarioPreset['workloadConfig']['sizeDistribution']): string => {
  switch (dist.type) {
    case 'fixed':
      return `Fixed — ${dist.cpu} CPU, ${dist.memory} GB, ${dist.gpu} GPU, ${fmtDuration(dist.duration)}`;
    case 'uniform':
      return `Uniform — CPU ${dist.cpuRange[0]}–${dist.cpuRange[1]}, Mem ${dist.memoryRange[0]}–${dist.memoryRange[1]} GB` +
        (dist.gpuRange[1] > 0 ? `, GPU ${dist.gpuRange[0]}–${dist.gpuRange[1]}` : '') +
        `, Duration ${fmtDuration(dist.durationRange[0])}–${fmtDuration(dist.durationRange[1])}`;
    case 'pareto':
      return `Pareto (α=${dist.alpha}) — min CPU ${dist.cpuMin}, min Mem ${dist.memoryMin} GB, min Duration ${fmtDuration(dist.durationMin)}`;
    case 'mixed':
      return `Mixed — ${dist.small}% small, ${dist.medium}% medium, ${dist.large}% large`;
    default:
      return 'Unknown';
  }
};

const phaseBadge = (phase: number) => {
  const labels: Record<number, { label: string; color: string }> = {
    1: { label: 'Phase 1 — MVP', color: 'blue' },
    2: { label: 'Phase 2 — Advanced', color: 'indigo' },
    4: { label: 'Stress Tests', color: 'red' },
    5: { label: 'Realistic Workloads', color: 'teal' },
    6: { label: 'Adversarial', color: 'orange' },
  };
  const { label, color } = labels[phase] ?? { label: `Phase ${phase}`, color: 'grey' };
  return <Badge size="xs" variant="light" color={color}>{label}</Badge>;
};

// ── Estimated Job Count ─────────────────────────────────────────────────────

const estimateJobCount = (preset: ScenarioPreset): string => {
  const { arrivalPattern, durationSeconds } = preset.workloadConfig;
  switch (arrivalPattern.type) {
    case 'poisson':
    case 'uniform': {
      const rate = arrivalPattern.type === 'poisson'
        ? arrivalPattern.lambdaPerMinute
        : arrivalPattern.ratePerMinute;
      return `~${Math.round(rate * (durationSeconds / 60))} jobs`;
    }
    case 'burst':
      return `${arrivalPattern.count} jobs`;
    case 'mmpp': {
      const avgRate = arrivalPattern.states.reduce((s, st) => s + st.lambdaPerMinute * st.weight, 0);
      return `~${Math.round(avgRate * (durationSeconds / 60))} jobs (avg)`;
    }
    case 'periodic_mix': {
      const total = arrivalPattern.templates.reduce(
        (s, t) => s + Math.floor(durationSeconds / t.intervalSeconds),
        0,
      );
      return `~${total} jobs`;
    }
    default:
      return '—';
  }
};

// ── Main Component ──────────────────────────────────────────────────────────

interface ScenarioDetailsProps {
  preset: ScenarioPreset;
  /** If true, starts collapsed (for results view) */
  defaultCollapsed?: boolean;
  /** Compact mode hides some details */
  compact?: boolean;
}

export const ScenarioDetails = ({ preset, defaultCollapsed = false, compact = false }: ScenarioDetailsProps) => {
  const [opened, setOpened] = useState(!defaultCollapsed);
  const wc = preset.workloadConfig;

  return (
    <Box
      p="sm"
      style={{
        border: '1px solid #E5E7EA',
        borderRadius: 8,
        background: opened ? '#FAFBFC' : '#fff',
      }}
    >
      <Group
        justify="space-between"
        style={{ cursor: 'pointer' }}
        onClick={() => setOpened(v => !v)}
      >
        <Group gap="sm">
          <Text size="sm" fw={600} c="grey.8">{preset.name}</Text>
          {phaseBadge(preset.phase)}
          <Badge size="xs" variant="outline" color="grey">{estimateJobCount(preset)}</Badge>
          <Badge size="xs" variant="outline" color="grey">{fmtDuration(wc.durationSeconds)}</Badge>
        </Group>
        <Text size="xs" c="dimmed" style={{ userSelect: 'none' }}>
          {opened ? '▾ collapse' : '▸ expand'}
        </Text>
      </Group>

      <Collapse in={opened}>
        <Stack gap="sm" mt="sm">
          {/* Description */}
          <Text size="xs" c="dimmed">{preset.description}</Text>

          {/* Quick stats */}
          <Group gap="lg">
            <Box>
              <Text size="xs" fw={500} c="grey.6">Arrival Pattern</Text>
              <Text size="xs" ff="monospace">{fmtRate(wc.arrivalPattern)}</Text>
            </Box>
            {wc.arrivalPattern.type !== 'periodic_mix' && (
              <Box>
                <Text size="xs" fw={500} c="grey.6">Job Size Distribution</Text>
                <Text size="xs" ff="monospace">{fmtSize(wc.sizeDistribution)}</Text>
              </Box>
            )}
            <Box>
              <Text size="xs" fw={500} c="grey.6">Duration</Text>
              <Text size="xs" ff="monospace">{fmtDuration(wc.durationSeconds)}</Text>
            </Box>
            <Box>
              <Text size="xs" fw={500} c="grey.6">Seed</Text>
              <Text size="xs" ff="monospace">{wc.seed}</Text>
            </Box>
          </Group>

          {/* MMPP state table */}
          {wc.arrivalPattern.type === 'mmpp' && (
            <Box>
              <Text size="xs" fw={500} c="grey.7" mb={4}>MMPP States</Text>
              <Table withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th><Text size="xs">State</Text></Table.Th>
                    <Table.Th><Text size="xs">Rate (jobs/min)</Text></Table.Th>
                    <Table.Th><Text size="xs">Weight</Text></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {wc.arrivalPattern.states.map(s => (
                    <Table.Tr key={s.label}>
                      <Table.Td><Text size="xs" fw={500}>{s.label}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{s.lambdaPerMinute}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{(s.weight * 100).toFixed(0)}%</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Text size="xs" c="dimmed" mt={2}>
                Transition interval: {fmtDuration(wc.arrivalPattern.transitionInterval)}
              </Text>
            </Box>
          )}

          {/* Mixed size class details */}
          {wc.sizeDistribution.type === 'mixed' && !compact && (
            <Box>
              <Text size="xs" fw={500} c="grey.7" mb={4}>Job Size Classes</Text>
              <Table withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th><Text size="xs">Class</Text></Table.Th>
                    <Table.Th><Text size="xs">Frequency</Text></Table.Th>
                    <Table.Th><Text size="xs">CPU</Text></Table.Th>
                    <Table.Th><Text size="xs">Memory (GB)</Text></Table.Th>
                    <Table.Th><Text size="xs">GPU</Text></Table.Th>
                    <Table.Th><Text size="xs">Duration</Text></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td><Badge size="xs" variant="light" color="green">Small</Badge></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{wc.sizeDistribution.small}%</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">4–16</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">16–64</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">0</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">1–3m</Text></Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td><Badge size="xs" variant="light" color="yellow">Medium</Badge></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{wc.sizeDistribution.medium}%</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">16–64</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">64–256</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">0</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">3–10m</Text></Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td><Badge size="xs" variant="light" color="red">Large</Badge></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{wc.sizeDistribution.large}%</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">64–256</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">256–1024</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">2–8</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">10–60m</Text></Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Box>
          )}

          {/* Periodic mix template table */}
          {wc.arrivalPattern.type === 'periodic_mix' && (
            <Box>
              <Text size="xs" fw={500} c="grey.7" mb={4}>Job Templates</Text>
              <Table withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th><Text size="xs">Job Type</Text></Table.Th>
                    <Table.Th><Text size="xs">Org</Text></Table.Th>
                    <Table.Th><Text size="xs">CPU</Text></Table.Th>
                    <Table.Th><Text size="xs">Memory (GB)</Text></Table.Th>
                    <Table.Th><Text size="xs">GPU</Text></Table.Th>
                    <Table.Th><Text size="xs">Duration</Text></Table.Th>
                    <Table.Th><Text size="xs">Interval</Text></Table.Th>
                    <Table.Th><Text size="xs">Est. Count</Text></Table.Th>
                    <Table.Th><Text size="xs">User Prio</Text></Table.Th>
                    <Table.Th><Text size="xs">Tool Prio</Text></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {wc.arrivalPattern.templates.map(t => (
                    <Table.Tr key={t.name}>
                      <Table.Td><Text size="xs" fw={500}>{t.name}</Text></Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color={
                          t.orgId === 'deeporigin' ? 'blue' :
                          t.orgId === 'org-beta' ? 'green' : 'orange'
                        }>
                          {t.orgId}
                        </Badge>
                      </Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{t.cpu}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{t.memory}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{t.gpu}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{fmtDuration(t.durationSeconds)}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">every {fmtDuration(t.intervalSeconds)}</Text></Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {Math.floor(wc.durationSeconds / t.intervalSeconds)}
                        </Text>
                      </Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{t.userPriority}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{t.toolPriority}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>

              {/* Per-org summary */}
              {!compact && (() => {
                const orgSummary: Record<string, { jobs: number; totalCpu: number }> = {};
                for (const t of wc.arrivalPattern.templates) {
                  const count = Math.floor(wc.durationSeconds / t.intervalSeconds);
                  if (!orgSummary[t.orgId]) orgSummary[t.orgId] = { jobs: 0, totalCpu: 0 };
                  orgSummary[t.orgId].jobs += count;
                  orgSummary[t.orgId].totalCpu += count * t.cpu;
                }
                return (
                  <Box mt="xs">
                    <Text size="xs" fw={500} c="grey.7" mb={4}>Per-Org Summary</Text>
                    <Group gap="lg">
                      {Object.entries(orgSummary).map(([orgId, s]) => (
                        <Box key={orgId}>
                          <Badge size="xs" variant="light" color={
                            orgId === 'deeporigin' ? 'blue' :
                            orgId === 'org-beta' ? 'green' : 'orange'
                          }>
                            {orgId}
                          </Badge>
                          <Text size="xs" ff="monospace" mt={2}>
                            {s.jobs} jobs · {s.totalCpu.toLocaleString()} total CPU-units
                          </Text>
                        </Box>
                      ))}
                    </Group>
                  </Box>
                );
              })()}
            </Box>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
};
