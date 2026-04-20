/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { memo, useMemo } from 'react';
import { Box, Button, Group, Menu, Stack, Text } from '@mantine/core';
import type { Job, Org, CRMQConfig, PredictionMap, Prediction } from '@/lib/types';
import { calcScore, fmtTime } from '@/lib/scheduler';
import { formatPrediction, getReasonLabel } from '@/lib/virtual-cluster';
import { getJobPoolType, getPoolMeta } from '@/lib/types';
import { normalizeFormulaType } from '@/lib/config/formulas/registry';
import { SCENARIO_PRESETS } from '@/lib/benchmark/traffic';
import { useVirtualScroll } from '@/hooks/use-virtual-scroll';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '@/lib/units';
import classes from './queue-panel.module.css';

interface QueuePanelProps {
  queue: Job[];
  simTime: number;
  reservTarget: string | null;
  cfg: CRMQConfig;
  orgs: Org[];
  predictions: PredictionMap;
  onAdd: () => void;
  onLoadScenario: (scenarioId: string) => void;
}

interface QueueItemProps {
  job: Job & { score: number; wait: number };
  rank: number;
  isTarget: boolean;
  cfg: CRMQConfig;
  orgs: Org[];
  prediction?: Prediction;
}

/**
 * Compute a formula-specific score breakdown for display.
 * Returns labeled components that match the actual scoring logic.
 */
const computeBreakdown = (
  formulaType: string,
  job: Job & { score: number; wait: number },
  cfg: CRMQConfig,
  org: Org | undefined,
): { parts: Array<{ label: string; value: string; color?: string }>; description: string } => {
  const priority = org?.priority ?? 1;

  switch (formulaType) {
    case 'current_weighted': {
      const s = cfg.scoring;
      const orgPart = priority * s.orgWeight;
      const userPart = job.userPriority * s.userWeight;
      const toolPart = job.toolPriority * s.toolWeight;
      const agePart = Math.round(job.wait * s.agingFactor);
      return {
        parts: [
          { label: 'Org', value: orgPart.toLocaleString() },
          { label: 'User', value: userPart.toLocaleString() },
          { label: 'Tool', value: toolPart.toLocaleString() },
          { label: 'Age', value: `+${agePart.toLocaleString()}`, color: 'var(--mantine-color-green-7)' },
        ],
        description: `P${priority}×${s.orgWeight} + P${job.userPriority}×${s.userWeight} + P${job.toolPriority}×${s.toolWeight} + ${Math.round(job.wait)}s×${s.agingFactor}`,
      };
    }
    case 'normalized_weighted_sum': {
      const wTier = 0.30, wAge = 0.30, wUser = 0.25, wTool = 0.15;
      const C = 10, tau = 60;
      const tierFactor = priority / 10;
      const userFactor = (job.userPriority - 1) / 4;
      const toolFactor = (job.toolPriority - 1) / 4;
      const rawAge = C * Math.log2(1 + job.wait / tau);
      const ageFactor = Math.min(1, rawAge / (C * Math.log2(1 + 3600 / tau)));
      return {
        parts: [
          { label: 'Tier', value: (wTier * tierFactor).toFixed(3) },
          { label: 'Age', value: (wAge * ageFactor).toFixed(3), color: 'var(--mantine-color-green-7)' },
          { label: 'User', value: (wUser * userFactor).toFixed(3) },
          { label: 'Tool', value: (wTool * toolFactor).toFixed(3) },
        ],
        description: `Normalized sum ≤ 1.0, log aging (wait=${Math.round(job.wait)}s)`,
      };
    }
    case 'drf_fair_share': {
      const rawAge = Math.min(1, (10 * Math.log2(1 + job.wait / 60)) / (10 * Math.log2(1 + 3600 / 60)));
      const userFactor = (job.userPriority - 1) / 4;
      const toolFactor = (job.toolPriority - 1) / 4;
      const withinOrg = 0.3 * userFactor + 0.2 * toolFactor + 0.5 * rawAge;
      return {
        parts: [
          { label: 'DRF', value: 'runtime' },
          { label: 'Within-org', value: (withinOrg * 100).toFixed(1) },
          { label: 'Age', value: rawAge.toFixed(3), color: 'var(--mantine-color-green-7)' },
        ],
        description: `DRF dominant share (runtime) + within-org score`,
      };
    }
    case 'balanced_composite': {
      const wPriority = 0.35;
      const wAging = 0.25;
      const wLoad = 0.20;
      const wCpuHrs = 0.20;
      const AGING_HORIZON = 21600;
      const AGING_EXPONENT = 2;
      const AGING_FLOOR = 0.10;
      const MAX_CPU_HOURS = 1000;   // vCPU·hours — matches platform default
      const maxPriority = 10;

      const orgPriorityNorm = priority / maxPriority;
      const t = Math.min(1, job.wait / AGING_HORIZON);
      const aging =
        AGING_FLOOR * t
        + (1 - AGING_FLOOR)
          * Math.pow(t, AGING_EXPONENT);
      const cpuHours = vcpuFromCpuMillis(job.resources.cpuMillis) * (job.estimatedDuration / 3600);
      const cpuHrsNorm = Math.min(
        1,
        Math.log(1 + cpuHours)
          / Math.log(1 + MAX_CPU_HOURS),
      );

      return {
        parts: [
          { label: 'Pri', value: (wPriority * orgPriorityNorm).toFixed(3) },
          { label: 'Age', value: (wAging * aging).toFixed(3), color: 'var(--mantine-color-green-7)' },
          { label: 'Load', value: 'runtime' },
          { label: 'CPU-h', value: (wCpuHrs * (1 - cpuHrsNorm)).toFixed(3) },
        ],
        description: `0.35×pri + 0.25×age² + 0.20×(1−cpu_load) + 0.20×(1−cpu_hrs) | cpu_hrs=${cpuHours.toFixed(1)} (wait=${Math.round(job.wait)}s)`,
      };
    }
    case 'strict_fifo': {
      return {
        parts: [
          { label: 'Arrival', value: `T=${Math.round(job.enqueuedAt)}s` },
        ],
        description: `Pure FIFO: earlier arrival = higher score`,
      };
    }
    default:
      return { parts: [{ label: 'Score', value: job.score.toLocaleString() }], description: '' };
  }
};

const QueueItem = memo(({ job, rank, isTarget, cfg, orgs, prediction }: QueueItemProps) => {
  const org = orgs.find((o) => o.id === job.orgId);
  const formulaType = normalizeFormulaType(cfg.formulaType ?? 'balanced_composite');
  const breakdown = computeBreakdown(formulaType, job, cfg, org);
  const fmt = prediction ? formatPrediction(prediction) : null;
  const reason = prediction ? getReasonLabel(prediction.blockingReason) : null;

  const poolType = getJobPoolType(job, cfg);
  const poolMeta = getPoolMeta(cfg, poolType);
  const poolLabel = poolMeta.shortLabel;
  const poolColor = poolMeta.color;

  return (
    <Box className={`${classes.queueItem} ${isTarget ? classes.queueItemTarget : ''}`}>
      <Stack gap={8}>
        <Group justify="space-between">
          <Group gap={8} wrap="wrap">
            <Text className={classes.rank}>#{rank}</Text>
            <Text className={classes.jobName}>{job.name}</Text>
            <Text className={classes.jobId}>[{job.id}]</Text>
            <Text size="xs" fw={500} px={6} py={2} style={{ background: poolColor + '20', color: poolColor, borderRadius: 4 }}>
              {poolLabel}
            </Text>
            {isTarget && <Text c="violet.6">🔒</Text>}
            {(job.skipCount || 0) > 0 && (
              <Text
                className={`${classes.skipBadge} ${
                  (job.skipCount || 0) >= cfg.scheduler.skipThreshold
                    ? classes.skipBadgeDanger
                    : classes.skipBadgeWarning
                }`}
              >
                ×{job.skipCount} skips
              </Text>
            )}
          </Group>
          <Group gap={8}>
            {fmt && prediction?.status === 'PREDICTED' && (
              <Text className={classes.predictionTime} style={{ color: fmt.css }} title={`Start in ${fmt.window} (${fmt.detail})`}>
                ⏱{fmt.label}
              </Text>
            )}
            <Text className={classes.score}>
              {Math.abs(job.score) >= 10
                ? Math.round(job.score).toLocaleString()
                : job.score.toFixed(3)}
            </Text>
          </Group>
        </Group>

        <Group gap="md" wrap="wrap">
          <Text className={classes.metaItem}>🏢 {org?.name} (P{org?.priority})</Text>
          <Text className={classes.metaItem}>👤 P{job.userPriority}</Text>
          <Text className={classes.metaItem}>🔧 P{job.toolPriority}</Text>
          <Text className={classes.metaItem}>⏳ {fmtTime(job.wait)}</Text>
          {reason && prediction?.blockingReason !== 'NONE' && (
            <Text size="xs" style={{ color: reason.css }}>
              {reason.icon} {reason.label}
            </Text>
          )}
        </Group>

        <Group gap={8} wrap="wrap">
          <Text className={classes.resourceTag}>
            CPU:{vcpuFromCpuMillis(job.resources.cpuMillis)}
          </Text>
          <Text className={classes.resourceTag}>
            MEM:{gbFromMemoryMiB(job.resources.memoryMiB)}GB
          </Text>
          <Text className={classes.resourceTag}>GPU:{job.resources.gpu}</Text>
          <Text className={classes.resourceTag}>
            Est:{fmtTime(job.estimatedDuration)}
          </Text>
        </Group>

        <Text className={classes.scoreBreakdown} title={breakdown.description}>
          {breakdown.parts.map((p, i) => (
            <span key={p.label}>
              {i > 0 && ' + '}
              {p.label}: <span style={p.color ? { color: p.color } : undefined}>{p.value}</span>
            </span>
          ))}
        </Text>
      </Stack>
    </Box>
  );
});

QueueItem.displayName = 'QueueItem';

/** Estimated height of each QueueItem in px */
const QUEUE_ITEM_HEIGHT = 130;
/** Height of the scrollable container in px */
const QUEUE_CONTAINER_HEIGHT = 480;

type ScoredJob = Job & { score: number; wait: number };

interface VirtualQueueListProps {
  scored: ScoredJob[];
  reservTarget: string | null;
  cfg: CRMQConfig;
  orgs: Org[];
  predictions: PredictionMap;
}

const VirtualQueueList = memo(
  ({
    scored,
    reservTarget,
    cfg,
    orgs,
    predictions,
  }: VirtualQueueListProps) => {
    const {
      containerRef,
      visibleItems,
      startIndex,
      topPad,
      bottomPad,
      onScroll,
    } = useVirtualScroll(
      scored,
      QUEUE_ITEM_HEIGHT,
      QUEUE_CONTAINER_HEIGHT,
    );

    if (scored.length === 0) return null;

    return (
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          maxHeight: QUEUE_CONTAINER_HEIGHT,
        }}
      >
        <div style={{ paddingTop: topPad }}>
          <Stack gap={8}>
            {visibleItems.map((job, i) => (
              <QueueItem
                key={job.id}
                job={job}
                rank={startIndex + i + 1}
                isTarget={
                  job.id === reservTarget
                }
                cfg={cfg}
                orgs={orgs}
                prediction={
                  predictions[job.id]
                }
              />
            ))}
          </Stack>
        </div>
        <div style={{ height: bottomPad }} />
      </div>
    );
  },
);

VirtualQueueList.displayName =
  'VirtualQueueList';

export const QueuePanel = memo(({ queue, simTime, reservTarget, cfg, orgs, predictions, onAdd, onLoadScenario }: QueuePanelProps) => {
  const scored = useMemo(
    () => [...queue]
      .map((j) => ({
        ...j,
        score: calcScore(j, simTime, cfg, orgs),
        wait: Math.max(0, simTime - j.enqueuedAt),
      }))
      .sort((a, b) => b.score - a.score),
    [queue, simTime, cfg, orgs],
  );

  return (
    <Box className={classes.card}>
      <Group justify="space-between" mb="sm">
        <Text className={classes.sectionTitle}>
          Priority Queue
          <span className={classes.countBadge}>{queue.length}</span>
        </Text>
        <Group gap={8}>
          <Menu shadow="md" width={320} position="bottom-end" withArrow>
            <Menu.Target>
              <Button variant="outline" color="indigo" size="compact-xs">
                📦 Load Scenario
              </Button>
            </Menu.Target>
            <Menu.Dropdown style={{ maxHeight: 400, overflowY: 'auto' }}>
              {[
                { phase: 1, label: 'Core' },
                { phase: 2, label: 'Advanced' },
                { phase: 4, label: 'Stress' },
                { phase: 5, label: 'Realistic' },
                { phase: 6, label: 'Adversarial' },
              ].flatMap(({ phase, label }, i) => {
                const items = SCENARIO_PRESETS
                  .filter(s => s.phase === phase && !s.benchmarkOnly);
                if (!items.length) return [];
                return [
                  ...(i > 0
                    ? [<Menu.Divider key={`d${phase}`} />]
                    : []),
                  <Menu.Label key={`l${phase}`}>
                    {label}
                  </Menu.Label>,
                  ...items.map(s => (
                    <Menu.Item
                      key={s.id}
                      onClick={() => onLoadScenario(s.id)}
                    >
                      <Text size="xs" fw={600}>
                        {s.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {s.description}
                      </Text>
                    </Menu.Item>
                  )),
                ];
              })}
            </Menu.Dropdown>
          </Menu>
          <Button variant="filled" color="indigo" size="compact-xs" onClick={onAdd}>
            + Add Job
          </Button>
        </Group>
      </Group>

      {scored.length === 0 && (
        <div className={classes.emptyState}>
          <div className={classes.emptyIcon}>📭</div>
          <div>Queue is empty — load a scenario or add a job</div>
        </div>
      )}

      <VirtualQueueList
        scored={scored}
        reservTarget={reservTarget}
        cfg={cfg}
        orgs={orgs}
        predictions={predictions}
      />

    </Box>
  );
});

QueuePanel.displayName = 'QueuePanel';
