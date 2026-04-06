/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useMemo } from 'react';
import { Badge, Box, Group, Modal, Stack, Table, Text } from '@mantine/core';
import type { CompletedJob, EvictedJob, Org, CRMQConfig } from '@/lib/types';
import { fmtTime } from '@/lib/scheduler';

interface SimResultsModalProps {
  opened: boolean;
  onClose: () => void;
  completed: CompletedJob[];
  evicted: EvictedJob[];
  orgs: Org[];
  cfg: CRMQConfig;
  simTime: number;
}

// ── Metric Computation ───────────────────────────────────────────────────────

interface OrgMetrics {
  orgId: string;
  orgName: string;
  priority: number;
  jobsCompleted: number;
  jobsEvicted: number;
  avgWaitTime: number;
  maxWaitTime: number;
  totalCpuSeconds: number;
}

interface AggMetrics {
  totalCompleted: number;
  totalEvicted: number;
  evictionRate: number;
  throughputPerMin: number;
  avgWaitTime: number;
  medianWaitTime: number;
  p95WaitTime: number;
  maxWaitTime: number;
  fairnessIndex: number;
  perOrg: OrgMetrics[];
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
};

const computeMetrics = (
  completed: CompletedJob[],
  evicted: EvictedJob[],
  orgs: Org[],
  simTime: number,
): AggMetrics => {
  const totalCompleted = completed.length;
  const totalEvicted = evicted.length;
  const total = totalCompleted + totalEvicted;
  const evictionRate = total > 0 ? totalEvicted / total : 0;

  // Throughput: completed jobs per minute of sim time
  const simMinutes = simTime / 60;
  const throughputPerMin = simMinutes > 0 ? totalCompleted / simMinutes : 0;

  // Wait times for completed jobs: time from enqueue to start
  // startedAt = completedAt - estimatedDuration (approximate)
  const waitTimes = completed.map(j => {
    const approxStart = j.completedAt - j.estimatedDuration;
    return Math.max(0, approxStart - j.enqueuedAt);
  });

  const sortedWaits = [...waitTimes].sort((a, b) => a - b);
  const avgWaitTime = waitTimes.length > 0
    ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
    : 0;
  const medianWaitTime = percentile(sortedWaits, 50);
  const p95WaitTime = percentile(sortedWaits, 95);
  const maxWaitTime = sortedWaits.length > 0 ? sortedWaits[sortedWaits.length - 1] : 0;

  // Per-org metrics
  const perOrg: OrgMetrics[] = orgs.map(org => {
    const orgCompleted = completed.filter(j => j.orgId === org.id);
    const orgEvicted = evicted.filter(j => j.orgId === org.id);

    const orgWaits = orgCompleted.map(j => {
      const approxStart = j.completedAt - j.estimatedDuration;
      return Math.max(0, approxStart - j.enqueuedAt);
    });

    const totalCpuSeconds = orgCompleted.reduce(
      (sum, j) => sum + j.resources.cpu * j.estimatedDuration,
      0,
    );

    return {
      orgId: org.id,
      orgName: org.name,
      priority: org.priority,
      jobsCompleted: orgCompleted.length,
      jobsEvicted: orgEvicted.length,
      avgWaitTime: orgWaits.length > 0
        ? orgWaits.reduce((a, b) => a + b, 0) / orgWaits.length
        : 0,
      maxWaitTime: orgWaits.length > 0 ? Math.max(...orgWaits) : 0,
      totalCpuSeconds,
    };
  });

  // Jain's Fairness Index on throughput per org
  // JFI = (sum xi)^2 / (n * sum xi^2)
  const completedCounts = perOrg.map(o => o.jobsCompleted);
  const n = completedCounts.length;
  const sumX = completedCounts.reduce((a, b) => a + b, 0);
  const sumX2 = completedCounts.reduce((a, b) => a + b * b, 0);
  const fairnessIndex = n > 0 && sumX2 > 0 ? (sumX * sumX) / (n * sumX2) : 0;

  return {
    totalCompleted,
    totalEvicted,
    evictionRate,
    throughputPerMin,
    avgWaitTime,
    medianWaitTime,
    p95WaitTime,
    maxWaitTime,
    fairnessIndex,
    perOrg,
  };
};

// ── Component ────────────────────────────────────────────────────────────────

export const SimResultsModal = ({
  opened,
  onClose,
  completed,
  evicted,
  orgs,
  cfg,
  simTime,
}: SimResultsModalProps) => {
  const metrics = useMemo(
    () => computeMetrics(completed, evicted, orgs, simTime),
    [completed, evicted, orgs, simTime],
  );

  const sectionStyle: React.CSSProperties = {
    padding: 16,
    border: '1px solid var(--mantine-color-grey-2)',
    borderRadius: 10,
    background: 'var(--mantine-color-grey-0)',
  };

  const thStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--mantine-color-grey-6)',
  };

  const hasData = metrics.totalCompleted > 0 || metrics.totalEvicted > 0;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap={8}>
          <Text fw={700} size="md">Simulation Results</Text>
          <Badge size="xs" variant="light" color="indigo">T = {fmtTime(simTime)}</Badge>
        </Group>
      }
      size="lg"
      centered
      overlayProps={{ backgroundOpacity: 0.35, blur: 3 }}
    >
      {!hasData ? (
        <Text size="sm" c="dimmed" ta="center" py="xl">
          No results yet — load a scenario and run the simulation first.
        </Text>
      ) : (
        <Stack gap="lg">
          {/* ── Overview Metrics ───────────────────────────────────── */}
          <Box style={sectionStyle}>
            <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="sm">
              Overview
            </Text>
            <Group gap="xl" wrap="wrap">
              <Box>
                <Text size="xs" c="dimmed">Completed</Text>
                <Text size="lg" fw={700} ff="monospace" c="green.7">
                  {metrics.totalCompleted}
                </Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">Evicted</Text>
                <Text size="lg" fw={700} ff="monospace" c="red.7">
                  {metrics.totalEvicted}
                </Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">Eviction Rate</Text>
                <Text size="lg" fw={700} ff="monospace">
                  {(metrics.evictionRate * 100).toFixed(1)}%
                </Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">Throughput</Text>
                <Text size="lg" fw={700} ff="monospace">
                  {metrics.throughputPerMin.toFixed(1)}/min
                </Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">Jain&apos;s Fairness</Text>
                <Text
                  size="lg"
                  fw={700}
                  ff="monospace"
                  c={metrics.fairnessIndex >= 0.85 ? 'green.7' : metrics.fairnessIndex >= 0.7 ? 'yellow.7' : 'red.7'}
                >
                  {metrics.fairnessIndex.toFixed(3)}
                </Text>
              </Box>
            </Group>
          </Box>

          {/* ── Wait Time Distribution ────────────────────────────── */}
          <Box style={sectionStyle}>
            <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="sm">
              Wait Times
            </Text>
            <Group gap="xl" wrap="wrap">
              <Box>
                <Text size="xs" c="dimmed">Average</Text>
                <Text size="sm" fw={600} ff="monospace">{fmtTime(Math.round(metrics.avgWaitTime))}</Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">Median</Text>
                <Text size="sm" fw={600} ff="monospace">{fmtTime(Math.round(metrics.medianWaitTime))}</Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">P95</Text>
                <Text size="sm" fw={600} ff="monospace">{fmtTime(Math.round(metrics.p95WaitTime))}</Text>
              </Box>
              <Box>
                <Text size="xs" c="dimmed">Max</Text>
                <Text size="sm" fw={600} ff="monospace">{fmtTime(Math.round(metrics.maxWaitTime))}</Text>
              </Box>
            </Group>
          </Box>

          {/* ── Per-Org Breakdown ──────────────────────────────────── */}
          <Box style={sectionStyle}>
            <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="sm">
              Per-Organization Breakdown
            </Text>
            <Table striped highlightOnHover withTableBorder withColumnBorders style={{ fontSize: 12 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={thStyle}>Organization</Table.Th>
                  <Table.Th style={{ ...thStyle, textAlign: 'right' }}>Completed</Table.Th>
                  <Table.Th style={{ ...thStyle, textAlign: 'right' }}>Evicted</Table.Th>
                  <Table.Th style={{ ...thStyle, textAlign: 'right' }}>Avg Wait</Table.Th>
                  <Table.Th style={{ ...thStyle, textAlign: 'right' }}>Max Wait</Table.Th>
                  <Table.Th style={{ ...thStyle, textAlign: 'right' }}>CPU·sec</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {metrics.perOrg.map(org => (
                  <Table.Tr key={org.orgId}>
                    <Table.Td>
                      <Group gap={6}>
                        <Text size="xs">{org.orgName}</Text>
                        <Badge size="xs" variant="light" color="violet">P{org.priority}</Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: 'var(--mantine-color-green-7)' }}>
                      {org.jobsCompleted}
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: org.jobsEvicted > 0 ? 'var(--mantine-color-red-7)' : undefined }}>
                      {org.jobsEvicted}
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                      {fmtTime(Math.round(org.avgWaitTime))}
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                      {fmtTime(Math.round(org.maxWaitTime))}
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                      {org.totalCpuSeconds.toLocaleString()}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        </Stack>
      )}
    </Modal>
  );
};
