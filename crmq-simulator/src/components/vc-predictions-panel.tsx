/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { memo, useMemo } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import type { Job, Org, CRMQConfig, PredictionMap } from '@/lib/types';
import { calcScore } from '@/lib/scheduler';
import { formatPrediction, getReasonLabel } from '@/lib/virtual-cluster';
import { useVirtualScroll } from '@/hooks/use-virtual-scroll';
import classes from './vc-predictions-panel.module.css';

interface VCPredictionsPanelProps {
  predictions: PredictionMap;
  queue: Job[];
  simTime: number;
  cfg: CRMQConfig;
  orgs: Org[];
}

const getReasonBg = (css: string): string => {
  if (css.includes('green')) return '#11A46820';
  if (css.includes('red')) return '#D93E3920';
  if (css.includes('amber')) return '#B2770020';
  if (css.includes('blue')) return '#4A65DC20';
  if (css.includes('purple')) return '#7638E520';
  if (css.includes('cyan')) return '#0891B220';
  if (css.includes('orange')) return '#B2770020';
  return '#D1D5DB20';
};

const getColor = (css: string): string => {
  if (css.includes('green')) return '#11A468';
  if (css.includes('red')) return '#D93E39';
  if (css.includes('amber')) return '#B27700';
  if (css.includes('blue')) return '#4A65DC';
  if (css.includes('purple')) return '#7638E5';
  if (css.includes('cyan')) return '#0891B2';
  if (css.includes('orange')) return '#B27700';
  return '#6B7280';
};

const PRED_ITEM_HEIGHT = 64;
const PRED_CONTAINER_HEIGHT = 220;

type ScoredJob = Job & { score: number };

interface VirtualPredListProps {
  scored: ScoredJob[];
  predictions: PredictionMap;
}

/** Only includes jobs that have predictions */
const VirtualPredictionsList = memo(
  ({ scored, predictions }: VirtualPredListProps) => {
    const withPreds = useMemo(
      () =>
        scored.filter(
          (j) => predictions[j.id] != null,
        ),
      [scored, predictions],
    );

    const {
      containerRef,
      visibleItems,
      topPad,
      bottomPad,
      onScroll,
    } = useVirtualScroll(
      withPreds,
      PRED_ITEM_HEIGHT,
      PRED_CONTAINER_HEIGHT,
    );

    if (withPreds.length === 0) return null;

    return (
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{
          height: PRED_CONTAINER_HEIGHT,
          overflowY: 'auto',
        }}
      >
        <div style={{ paddingTop: topPad }}>
          <Stack gap={8}>
            {visibleItems.map((job) => {
              const pred = predictions[job.id];
              if (!pred) return null;
              const fmt = formatPrediction(pred);
              const reason = getReasonLabel(
                pred.blockingReason,
              );
              return (
                <Box
                  key={job.id}
                  className={
                    classes.predictionCard
                  }
                >
                  <Stack gap={6}>
                    <Group justify="space-between">
                      <Group gap={8}>
                        <Text
                          size="xs"
                          c="grey.9"
                          fw={500}
                        >
                          {job.name}
                        </Text>
                        <Text
                          size="xs"
                          c="dimmed"
                          ff="monospace"
                        >
                          [{job.id}]
                        </Text>
                      </Group>
                      <Box>
                        {pred.status ===
                          'PREDICTED' &&
                          pred.delta !== null && (
                            <Text
                              fw={700}
                              ff="monospace"
                              size="sm"
                              style={{
                                color: getColor(
                                  fmt.css,
                                ),
                              }}
                            >
                              {fmt.label}
                            </Text>
                          )}
                        {pred.status ===
                          'WILL_EXPIRE' && (
                          <Text
                            size="xs"
                            fw={700}
                            c="red.6"
                          >
                            Will expire
                          </Text>
                        )}
                        {pred.status ===
                          'UNPREDICTABLE' && (
                          <Text
                            size="xs"
                            c="dimmed"
                          >
                            Unknown
                          </Text>
                        )}
                      </Box>
                    </Group>
                    <Group justify="space-between">
                      <Text
                        className={classes.vcBadge}
                        style={{
                          background: getReasonBg(
                            reason.css,
                          ),
                          color: getColor(
                            reason.css,
                          ),
                        }}
                      >
                        {reason.icon}{' '}
                        {reason.label}
                      </Text>
                      {pred.status ===
                        'PREDICTED' &&
                        pred.variance !== null && (
                          <Text
                            size="xs"
                            c="dimmed"
                            ff="monospace"
                          >
                            {fmt.window}{' '}
                            <span
                              style={{
                                color: '#6B7280',
                              }}
                            >
                              (
                              {pred.variance}%)
                            </span>
                          </Text>
                        )}
                    </Group>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </div>
        <div style={{ height: bottomPad }} />
      </div>
    );
  },
);

VirtualPredictionsList.displayName =
  'VirtualPredictionsList';

export const VCPredictionsPanel = memo(({ predictions, queue, simTime, cfg, orgs }: VCPredictionsPanelProps) => {
  const scored = useMemo(
    () => [...queue]
      .map((j) => ({
        ...j,
        score: Math.round(
          calcScore(j, simTime, cfg, orgs),
        ),
      }))
      .sort((a, b) => b.score - a.score),
    [queue, simTime, cfg, orgs],
  );

  const hasPreds = Object.keys(predictions).length > 0;

  return (
    <Box className={classes.card}>
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap={8}>
            <Text c="cyan.6">🔮</Text>
            <Text className={classes.sectionTitle}>Virtual Cluster — Time-to-Start</Text>
          </Group>
          <Text size="xs" c="dimmed">§2.3</Text>
        </Group>

        {!hasPreds && (
          <Text size="xs" c="dimmed" ta="center" py="sm">
            Add jobs to queue to see Time-to-Start predictions
          </Text>
        )}

        <VirtualPredictionsList
          scored={scored}
          predictions={predictions}
        />

        {hasPreds && (
          <Text className={classes.footer}>
            Predictions recalculate dynamically. Variance reflects estimation uncertainty.
          </Text>
        )}
      </Stack>
    </Box>
  );
});

VCPredictionsPanel.displayName = 'VCPredictionsPanel';
