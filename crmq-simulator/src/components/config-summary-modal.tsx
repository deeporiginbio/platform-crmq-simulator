/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useMemo } from 'react';
import { Badge, Box, Group, Modal, Stack, Table, Text } from '@mantine/core';
import type { CRMQConfig, Org, Resources } from '@/lib/types';
import { MEMORY_PER_CPU, CPU_PER_GPU, getQuotaLabel } from '@/lib/config/types';
import { getFormula, normalizeFormulaType } from '@/lib/config/formulas/registry';
import { resolveLimitToAbsolute } from '@/lib/config/limits/registry';
import type { LimitValue } from '@/lib/config/types';

interface ConfigSummaryModalProps {
  opened: boolean;
  onClose: () => void;
  cfg: CRMQConfig;
  orgs: Org[];
}

const fmtResource = (val: number) => val.toLocaleString();
const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

/**
 * Build LimitValue from an org's raw limit Resources for a given pool.
 * In the simulator the org.limits are always absolute Resources.
 */
const buildLimitValue = (resources: Resources): LimitValue => ({
  mode: 'absolute' as const,
  resources,
});

export const ConfigSummaryModal = ({ opened, onClose, cfg, orgs }: ConfigSummaryModalProps) => {
  const formulaType = normalizeFormulaType(cfg.formulaType ?? 'current_weighted');
  const formulaDef = useMemo(() => getFormula(formulaType), [formulaType]);

  // Build formula params for display
  const formulaParams = useMemo(() => {
    if (cfg.formulaParams && Object.keys(cfg.formulaParams).length > 0) {
      return cfg.formulaParams;
    }
    if (formulaType === 'current_weighted') {
      return { ...cfg.scoring };
    }
    return structuredClone(formulaDef.defaultParams) as Record<string, unknown>;
  }, [cfg, formulaType, formulaDef]);

  // Resolve org limits to absolute values per pool
  const resolvedLimits = useMemo(() => {
    const result: Record<string, Record<string, Resources>> = {};
    for (const org of orgs) {
      result[org.id] = {};
      for (const pool of cfg.cluster.pools) {
        const rawLimit = org.limits[pool.type];
        if (!rawLimit) {
          result[org.id][pool.type] = { ...pool.total };
        } else {
          const limitValue = buildLimitValue(rawLimit);
          result[org.id][pool.type] = resolveLimitToAbsolute(limitValue, pool.total);
        }
      }
    }
    return result;
  }, [orgs, cfg.cluster.pools]);

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

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap={8}>
          <Text fw={700} size="md">Active Configuration</Text>
        </Group>
      }
      size="lg"
      centered
      overlayProps={{ backgroundOpacity: 0.35, blur: 3 }}
    >
      <Stack gap="lg">
        {/* ── Formula Section ──────────────────────────────────────────── */}
        <Box style={sectionStyle}>
          <Group gap={8} mb="xs">
            <Text size="xs" fw={600} c="grey.7" tt="uppercase">Scheduling Formula</Text>
            <Badge size="xs" variant="light" color="indigo">{formulaDef.label}</Badge>
          </Group>
          <Text size="xs" c="dimmed" mb="sm">{formulaDef.description}</Text>
          <Group gap="lg">
            {Object.entries(formulaParams).map(([key, value]) => (
              <Box key={key}>
                <Text size="xs" c="dimmed">{key}</Text>
                <Text size="sm" fw={600} ff="monospace">{String(value)}</Text>
              </Box>
            ))}
          </Group>
        </Box>

        {/* ── Scheduler Tuning ─────────────────────────────────────────── */}
        <Box style={sectionStyle}>
          <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="xs">Scheduler Tuning</Text>
          <Group gap="lg">
            <Box>
              <Text size="xs" c="dimmed">Top-N</Text>
              <Text size="sm" fw={600} ff="monospace">{cfg.scheduler.topN}</Text>
            </Box>
            <Box>
              <Text size="xs" c="dimmed">Skip Threshold</Text>
              <Text size="sm" fw={600} ff="monospace">{cfg.scheduler.skipThreshold}</Text>
            </Box>
            <Box>
              <Text size="xs" c="dimmed">Backfill Max Ratio</Text>
              <Text size="sm" fw={600} ff="monospace">{cfg.scheduler.backfillMaxRatio}</Text>
            </Box>
          </Group>
        </Box>

        {/* ── Resolved Org Limits ──────────────────────────────────────── */}
        <Box style={sectionStyle}>
          <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="xs">
            Resolved Org Limits (Effective Absolute Values)
          </Text>
          <Text size="xs" c="dimmed" mb="sm">
            CPU pools: user sets CPU, memory derived ({MEMORY_PER_CPU} GB/CPU), no GPU.
            GPU pools: user sets GPU, CPU derived ({CPU_PER_GPU} CPU/GPU), memory derived.
          </Text>

          {cfg.cluster.pools.map((pool) => {
            const isCpuPool = pool.quotaType === 'cpu';
            const primaryLabel = getQuotaLabel(pool.quotaType);
            const capacityParts = isCpuPool
              ? `${fmtResource(pool.total.cpu)} CPU, ${fmtResource(pool.total.memory)} GB`
              : `${fmtResource(pool.total.gpu)} GPU, ${fmtResource(pool.total.cpu)} CPU, ${fmtResource(pool.total.memory)} GB`;

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
                <Table striped highlightOnHover withTableBorder withColumnBorders style={{ fontSize: 12 }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={thStyle}>Organization</Table.Th>
                      <Table.Th style={thStyle}>Mode</Table.Th>
                      {isCpuPool && (
                        <Table.Th style={{ ...thStyle, textAlign: 'right' }}>CPU (configured)</Table.Th>
                      )}
                      {!isCpuPool && (
                        <Table.Th style={{ ...thStyle, textAlign: 'right' }}>GPU (configured)</Table.Th>
                      )}
                      {!isCpuPool && (
                        <Table.Th style={{ ...thStyle, textAlign: 'right' }}>CPU (derived)</Table.Th>
                      )}
                      <Table.Th style={{ ...thStyle, textAlign: 'right' }}>Memory GB (derived)</Table.Th>
                      {!isCpuPool && (
                        <Table.Th style={{ ...thStyle, textAlign: 'right' }}>GPU</Table.Th>
                      )}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {orgs.map((org) => {
                      const resolved = resolvedLimits[org.id]?.[pool.type] ?? { cpu: 0, memory: 0, gpu: 0 };
                      const primaryValue = isCpuPool ? resolved.cpu : resolved.gpu;

                      return (
                        <Table.Tr key={org.id}>
                          <Table.Td>
                            <Group gap={6}>
                              <Text size="xs">{org.name}</Text>
                              <Badge size="xs" variant="light" color="violet">P{org.priority}</Badge>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="xs" variant="light" color="grey" radius="sm">
                              absolute
                            </Badge>
                          </Table.Td>
                          <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>
                            {fmtResource(primaryValue)}
                          </Table.Td>
                          {!isCpuPool && (
                            <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--mantine-color-dimmed)' }}>
                              {fmtResource(resolved.cpu)}
                            </Table.Td>
                          )}
                          <Table.Td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--mantine-color-dimmed)' }}>
                            {fmtResource(resolved.memory)}
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
    </Modal>
  );
};
