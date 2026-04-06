/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Group, ScrollArea, Stack, Text } from '@mantine/core';
import type { CompletedJob, EvictedJob } from '@/lib/types';
import { fmtTime } from '@/lib/scheduler';
import classes from './history-panel.module.css';

interface HistoryPanelProps {
  completed: CompletedJob[];
  evicted: EvictedJob[];
}

export const HistoryPanel = ({ completed, evicted }: HistoryPanelProps) => {
  return (
    <Box className={classes.card}>
      <Stack gap={8}>
        <Text className={classes.sectionTitle}>
          History <span className={classes.countInfo}>({completed.length} done · {evicted.length} evicted)</span>
        </Text>
        <ScrollArea h={100}>
          <Stack gap={2}>
            {completed.slice(0, 8).map((j) => (
              <Group key={j.id + 'c'} justify="space-between">
                <Text size="xs" c="dimmed">✅ {j.name}</Text>
                <Text size="xs" c="green.6">{fmtTime(j.estimatedDuration)}</Text>
              </Group>
            ))}
            {evicted.slice(0, 4).map((j) => (
              <Group key={j.id + 'e'} justify="space-between">
                <Text size="xs" c="gray.6">⏰ {j.name}</Text>
                <Text size="xs" c="red.6">TTL</Text>
              </Group>
            ))}
            {completed.length === 0 && evicted.length === 0 && (
              <Text size="xs" c="dimmed" ta="center" py={4}>No history</Text>
            )}
          </Stack>
        </ScrollArea>
      </Stack>
    </Box>
  );
};
