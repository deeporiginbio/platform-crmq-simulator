/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useMemo } from 'react';
import { Alert, Badge, Box, Group, Stack, Table, Text } from '@mantine/core';
import type { Org, Resources } from '@/lib/types';
import type { SchedulingPolicyConfig, ValidationMessage } from '@/lib/config/types';
import { MEMORY_GB_PER_VCPU, VCPU_PER_GPU, getQuotaLabel } from '@/lib/config/types';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '@/lib/units';
import { getFormula } from '@/lib/config/formulas/registry';
import { resolveAllLimits } from '@/lib/config/use-config-validation';
import classes from './review-step.module.css';

interface ReviewStepProps {
  config: SchedulingPolicyConfig;
  orgs: Org[];
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
}

const fmtResource = (val: number) => val.toLocaleString();

export const ReviewStep = ({ config, orgs, errors, warnings }: ReviewStepProps) => {
  const formulaDef = useMemo(() => getFormula(config.formula.type), [config.formula.type]);
  const resolvedLimits = useMemo(() => resolveAllLimits(config), [config]);

  return (
    <Stack gap="lg" mt="md">
      {/* Validation Messages */}
      {errors.length > 0 && (
        <Alert color="red" variant="light" title={`${errors.length} error${errors.length > 1 ? 's' : ''}`}>
          <Stack gap={4}>
            {errors.map((e, i) => (
              <Text key={i} size="xs">{e.message}</Text>
            ))}
          </Stack>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert color="yellow" variant="light" title={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}>
          <Stack gap={4}>
            {warnings.map((w, i) => (
              <Text key={i} size="xs">{w.message}</Text>
            ))}
          </Stack>
        </Alert>
      )}

      {/* Formula Summary */}
      <Box className={classes.section}>
        <Group gap={8} mb="xs">
          <Text size="xs" fw={600} c="grey.7" tt="uppercase">Scheduling Formula</Text>
          <Badge size="xs" variant="light" color="indigo">{formulaDef.label}</Badge>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">{formulaDef.description}</Text>
        <Group gap="lg">
          {Object.entries(config.formula.params as unknown as Record<string, unknown>).map(([key, value]) => (
            <Box key={key}>
              <Text size="xs" c="dimmed">{key}</Text>
              <Text size="sm" fw={600} ff="monospace">{String(value)}</Text>
            </Box>
          ))}
        </Group>
      </Box>

      {/* Scheduler Params */}
      <Box className={classes.section}>
        <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="xs">Scheduler Tuning</Text>
        <Group gap="lg">
          <Box>
            <Text size="xs" c="dimmed">Top-N</Text>
            <Text size="sm" fw={600} ff="monospace">{config.scheduler.topN}</Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Reservation Threshold</Text>
            <Text size="sm" fw={600} ff="monospace">{config.scheduler.reservationThresholdSec}s</Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed">Backfill Max Ratio</Text>
            <Text size="sm" fw={600} ff="monospace">{config.scheduler.backfillMaxRatio}</Text>
          </Box>
        </Group>
      </Box>

      {/* Resolved Limits Table */}
      <Box className={classes.section}>
        <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="xs">
          Resolved Org Limits (Effective Absolute Values)
        </Text>
        <Text size="xs" c="dimmed" mb="sm">
          CPU pools: user sets CPU, memory derived ({MEMORY_GB_PER_VCPU} GB/CPU), no
          GPU.
          GPU pools: user sets GPU, CPU derived ({VCPU_PER_GPU} CPU/GPU), memory
          derived.
        </Text>

        {config.cluster.pools.map((pool) => {
          const isCpuPool = pool.quotaType === 'cpu';
          const primaryLabel = getQuotaLabel(pool.quotaType);
          const capacityParts = isCpuPool
            ? `${fmtResource(vcpuFromCpuMillis(pool.total.cpuMillis))} CPU, ${fmtResource(gbFromMemoryMiB(pool.total.memoryMiB))} GB`
            : `${fmtResource(pool.total.gpu)} GPU, ${fmtResource(vcpuFromCpuMillis(pool.total.cpuMillis))} CPU, ${fmtResource(gbFromMemoryMiB(pool.total.memoryMiB))} GB`;

          return (
          <Box key={pool.type} mb="md">
            <Group gap={6} mb={4}>
              <Box style={{ width: 8, height: 8, borderRadius: '50%', background: pool.color }} />
              <Text size="xs" fw={600}>{pool.label}</Text>
              <Badge size="xs" variant="outline" color="grey" radius="sm">
                {isCpuPool ? 'CPU pool' : 'GPU pool'}
              </Badge>
              <Text size="xs" c="dimmed">({capacityParts})</Text>
            </Group>
            <Table striped highlightOnHover withTableBorder withColumnBorders className={classes.table}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Organization</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>Quota %</Table.Th>
                  <Table.Th style={{ textAlign: 'right' }}>{primaryLabel} (resolved)</Table.Th>
                  {!isCpuPool && <Table.Th style={{ textAlign: 'right' }}>CPU (derived)</Table.Th>}
                  <Table.Th style={{ textAlign: 'right' }}>Memory GB (derived)</Table.Th>
                  {!isCpuPool && <Table.Th style={{ textAlign: 'right' }}>GPU</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {config.orgQuotas.map((oq) => {
                  const org = orgs.find(o => o.id === oq.orgId);
                  const pct = oq.limits[pool.type];
                  const pctLabel = typeof pct === 'number' ? `${pct}%` : '—';
                  const resolved = resolvedLimits[oq.orgId]?.[pool.type] ?? {
                    cpuMillis: 0,
                    memoryMiB: 0,
                    gpu: 0,
                  };
                  const primaryValue = isCpuPool
                    ? vcpuFromCpuMillis(resolved.cpuMillis)
                    : resolved.gpu;

                  return (
                    <Table.Tr key={oq.orgId}>
                      <Table.Td>
                        <Group gap={6}>
                          <Text size="xs">{org?.name ?? oq.orgId}</Text>
                          <Badge size="xs" variant="light" color="violet">P{org?.priority ?? 0}</Badge>
                        </Group>
                      </Table.Td>
                      <Table.Td
                        style={{
                          textAlign: 'right',
                          fontFamily: 'monospace',
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {pctLabel}
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>
                        {fmtResource(primaryValue)}
                      </Table.Td>
                      {!isCpuPool && (
                        <Table.Td
                          style={{
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            fontSize: 12,
                            color: 'var(--mantine-color-dimmed)',
                          }}
                        >
                          {fmtResource(vcpuFromCpuMillis(resolved.cpuMillis))}
                        </Table.Td>
                      )}
                      <Table.Td
                        style={{
                          textAlign: 'right',
                          fontFamily: 'monospace',
                          fontSize: 12,
                          color: 'var(--mantine-color-dimmed)',
                        }}
                      >
                        {fmtResource(gbFromMemoryMiB(resolved.memoryMiB))}
                      </Table.Td>
                      {!isCpuPool && (
                        <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--mantine-color-dimmed)' }}>
                          {fmtResource(resolved.gpu)}
                        </Table.Td>
                      )}
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Box>
          );
        })}
      </Box>
    </Stack>
  );
};
