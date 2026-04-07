/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { memo } from 'react';
import { Box, ScrollArea, Stack, Text } from '@mantine/core';
import type { LogEntry } from '@/lib/types';
import { fmtTime } from '@/lib/scheduler';
import classes from './log-panel.module.css';

interface LogPanelProps {
  logs: LogEntry[];
}

export const LogPanel = memo(({ logs }: LogPanelProps) => {
  const logColorClass: Record<string, string> = {
    success: classes.success,
    warn: classes.warn,
    error: classes.error,
    info: classes.info,
  };

  return (
    <Box className={classes.card}>
      <Text className={classes.sectionTitle}>Scheduling Log</Text>
      <ScrollArea h={130}>
        <Stack gap={2}>
          {logs.length === 0 && <Text size="xs" c="dimmed">Press ▶ Run or load presets…</Text>}
          {logs.map((l) => (
            <Text key={l.id} className={`${classes.logEntry} ${logColorClass[l.type] ?? classes.info}`}>
              <span className={classes.timestamp}>[{fmtTime(l.t)}]</span> {l.msg}
            </Text>
          ))}
        </Stack>
      </ScrollArea>
    </Box>
  );
});

LogPanel.displayName = 'LogPanel';
