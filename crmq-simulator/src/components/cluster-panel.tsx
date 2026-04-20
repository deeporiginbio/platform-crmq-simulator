/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { memo, useState } from 'react';
import { Box, Group, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import type { Resources } from '@/lib/types';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '@/lib/units';
import classes from './cluster-panel.module.css';

interface PoolDisplayData {
  label: string;
  total: Resources;
  reserved: Resources;
  inUse: Resources;
  avail: Resources;
}

interface ClusterPanelProps {
  pools: PoolDisplayData[];
}

interface ResBarProps {
  label: string;
  total: number;
  reserved: number;
  inUse: number;
  unit: string;
  color: string;
}

const ResBar = ({ label, total, reserved, inUse, unit, color }: ResBarProps) => {
  const rPct = total > 0 ? (reserved / total) * 100 : 0;
  const iPct = total > 0 ? (inUse / total) * 100 : 0;
  const util = total > 0 ? Math.round((inUse + reserved) / total * 100) : 0;

  return (
    <Box>
      <Group justify="space-between" mb={4}>
        <Text size="xs" c="gray.6">{label}</Text>
        <Text
          size="xs"
          ff="monospace"
          className={util > 90 ? classes.barLabelDanger : util > 70 ? classes.barLabelWarning : classes.barLabel}
        >
          {inUse + reserved}/{total} {unit} ({util}%)
        </Text>
      </Group>
      <div className={classes.barTrack}>
        <div style={{ width: `${rPct}%`, background: '#B2770030', borderRight: '1px solid #B2770050' }} />
        <div style={{ width: `${iPct}%`, background: util > 90 ? '#D93E39' : util > 70 ? '#B27700' : color }} />
      </div>
      <Group gap="md" mt={2}>
        <Text className={classes.legendItem}>🟡 {reserved} rsrvd</Text>
        <Text className={classes.legendItem} style={{ color }}>● {inUse} in-use</Text>
        <Text className={classes.legendItem} c="green.9">◌ {total - reserved - inUse} free</Text>
      </Group>
    </Box>
  );
};

export const ClusterPanel = memo(({ pools }: ClusterPanelProps) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (label: string) => {
    setCollapsed(prev => ({ ...prev, [label]: !prev[label] }));
  };

  return (
    <Box className={classes.card}>
      <Stack gap="sm">
        <Text className={classes.sectionTitle}>Cluster Resources</Text>
        {pools.map((pool) => {
          const isCollapsed = collapsed[pool.label] ?? true;
          const totalUtilNum = vcpuFromCpuMillis(pool.total.cpuMillis);
          const totalUtil = totalUtilNum > 0
            ? Math.round(
                (
                  (vcpuFromCpuMillis(pool.inUse.cpuMillis) +
                    vcpuFromCpuMillis(pool.reserved.cpuMillis)) /
                  totalUtilNum
                ) * 100
              )
            : 0;

          return (
            <Box key={pool.label} className={classes.poolSection}>
              <UnstyledButton
                onClick={() => toggle(pool.label)}
                className={classes.poolHeader}
              >
                <Stack gap={2} w="100%">
                  <Group gap={6}>
                    <Text size="xs" c="dimmed" className={classes.chevron}>
                      {isCollapsed ? '▸' : '▾'}
                    </Text>
                    <Text size="sm" fw={600} c="indigo.7">{pool.label}</Text>
                  </Group>
                  {isCollapsed && (
                    <Text size="xs" ff="monospace" c="dimmed" ml={18}>
                      {totalUtil}% util · {vcpuFromCpuMillis(pool.avail.cpuMillis)} CPU
                      free
                      {pool.total.gpu > 0
                        ? ` · ${pool.avail.gpu} GPU free`
                        : ''}
                    </Text>
                  )}
                </Stack>
              </UnstyledButton>

              {!isCollapsed && (
                <Stack gap="sm" mt="xs">
                  <ResBar
                    label="CPU"
                    total={vcpuFromCpuMillis(pool.total.cpuMillis)}
                    reserved={vcpuFromCpuMillis(pool.reserved.cpuMillis)}
                    inUse={vcpuFromCpuMillis(pool.inUse.cpuMillis)}
                    unit="cores"
                    color="#4A65DC"
                  />
                  <ResBar
                    label="Memory"
                    total={gbFromMemoryMiB(pool.total.memoryMiB)}
                    reserved={gbFromMemoryMiB(pool.reserved.memoryMiB)}
                    inUse={gbFromMemoryMiB(pool.inUse.memoryMiB)}
                    unit="GB"
                    color="#7638E5"
                  />
                  {pool.total.gpu > 0 && (
                    <ResBar label="GPU" total={pool.total.gpu} reserved={pool.reserved.gpu} inUse={pool.inUse.gpu} unit="cards" color="#11A468" />
                  )}
                  <SimpleGrid
                    cols={pool.total.gpu > 0 ? 3 : 2}
                    spacing="xs"
                    style={{ paddingTop: 4 }}
                  >
                    {(['CPU', 'MEM'] as const).map((l) => {
                      const v =
                        l === 'CPU'
                          ? vcpuFromCpuMillis(pool.avail.cpuMillis)
                          : gbFromMemoryMiB(pool.avail.memoryMiB);
                      return (
                        <Box key={l} ta="center">
                          <Text className={`${classes.freeValue} ${v > 0 ? classes.freeValuePositive : classes.freeValueNegative}`}>{v}</Text>
                          <Text className={classes.freeLabel}>{l} free</Text>
                        </Box>
                      );
                    })}
                    {pool.total.gpu > 0 && (
                      <Box ta="center">
                        <Text className={`${classes.freeValue} ${pool.avail.gpu > 0 ? classes.freeValuePositive : classes.freeValueNegative}`}>{pool.avail.gpu}</Text>
                        <Text className={classes.freeLabel}>GPU free</Text>
                      </Box>
                    )}
                  </SimpleGrid>
                </Stack>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
});

ClusterPanel.displayName = 'ClusterPanel';
