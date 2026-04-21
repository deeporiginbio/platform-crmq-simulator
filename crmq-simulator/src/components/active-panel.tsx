/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { memo } from 'react';
import { Box, Group, ScrollArea, Stack, Text } from '@mantine/core';
import type { RunningJob, CRMQConfig } from '@/lib/types';
import { fmtTime } from '@/lib/scheduler';
import { getPoolMeta, jobPools, jobResInPool } from '@/lib/types';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '@/lib/units';
import classes from './active-panel.module.css';

interface ActivePanelProps {
  jobs: RunningJob[];
  simTime: number;
  cfg: CRMQConfig;
}

export const ActivePanel = memo(({ jobs, simTime, cfg }: ActivePanelProps) => {
  return (
    <Box className={classes.card}>
      <Stack gap="sm">
        <Text className={classes.sectionTitle}>
          Running<span className={classes.countBadge}>{jobs.length}</span>
        </Text>
        {jobs.length === 0 && (
          <Text size="xs" c="dimmed" ta="center" py="xs">No running jobs</Text>
        )}
        <ScrollArea h={160}>
          <Stack gap={8}>
            {jobs.map((j) => {
              const pct = Math.min(100, Math.round((simTime - j.startedAt) / j.estimatedDuration * 100));
              const pools = jobPools(j);
              return (
                <Box key={j.id} className={classes.jobCard}>
                  <Stack gap={4}>
                    <Group justify="space-between">
                      <Group gap={6}>
                        <Text size="xs" c="grey.9" fw={500}>{j.name}</Text>
                        {pools.map((pt) => {
                          const meta = getPoolMeta(cfg, pt);
                          return (
                            <Text
                              key={pt}
                              size="xs"
                              fw={500}
                              px={4}
                              py={1}
                              style={{ background: meta.color + '20', color: meta.color, borderRadius: 3 }}
                            >
                              {meta.shortLabel}
                            </Text>
                          );
                        })}
                      </Group>
                      <Text size="xs" c="green.6" ff="monospace">{fmtTime(j.remainingDuration)}</Text>
                    </Group>
                    <Group gap={8}>
                      {pools.map((pt) => {
                        const slice = jobResInPool(j, pt);
                        const meta = getPoolMeta(cfg, pt);
                        const parts: string[] = [];
                        if (slice.cpuMillis > 0) parts.push(`CPU:${vcpuFromCpuMillis(slice.cpuMillis)}`);
                        if (slice.memoryMiB > 0) parts.push(`MEM:${gbFromMemoryMiB(slice.memoryMiB)}GB`);
                        if (slice.gpu > 0) parts.push(`GPU:${slice.gpu}`);
                        return (
                          <Text key={pt} size="xs" c="dimmed" title={meta.label}>
                            {pools.length > 1 ? `${meta.shortLabel} ` : ''}{parts.join(' ')}
                          </Text>
                        );
                      })}
                      <Text size="xs" c="dimmed" ml="auto">{pct}%</Text>
                    </Group>
                    <div className={classes.barTrack}>
                      <div className={classes.barFill} style={{ width: `${pct}%`, background: '#11A468' }} />
                    </div>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </ScrollArea>
      </Stack>
    </Box>
  );
});

ActivePanel.displayName = 'ActivePanel';
