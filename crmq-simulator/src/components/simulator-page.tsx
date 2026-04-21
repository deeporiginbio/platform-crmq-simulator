/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { Box, Button, Group, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { sumResourcesInPool, sub3, fmtTime } from '@/lib/scheduler';
import { useConfigStore } from '@/lib/store';
import { normalizeFormulaType } from '@/lib/config/formulas/registry';
import { useSimStore } from '@/lib/sim-store';
import { vcpuFromCpuMillis } from '@/lib/units';

import { ClusterPanel } from '@/components/cluster-panel';
import { OrgPanel } from '@/components/org-panel';
import { QueuePanel } from '@/components/queue-panel';
import { VCPredictionsPanel } from '@/components/vc-predictions-panel';
import { ActivePanel } from '@/components/active-panel';
import { HistoryPanel } from '@/components/history-panel';
import { LogPanel } from '@/components/log-panel';
import { AddJobModal } from '@/components/add-job-modal';
import { ConfigSummaryModal } from '@/components/config-summary-modal';
import { SimResultsModal } from '@/components/sim-results-modal';

import styles from './simulator-page.module.css';

export const SimulatorPage = () => {
  // Config store
  const cfg = useConfigStore((s) => s.cfg);
  const orgs = useConfigStore((s) => s.orgs);

  // Sim store — all simulation state + actions
  const simTime = useSimStore((s) => s.simTime);
  const running = useSimStore((s) => s.running);
  const speed = useSimStore((s) => s.speed);
  const queue = useSimStore((s) => s.queue);
  const active = useSimStore((s) => s.active);
  const completed = useSimStore((s) => s.completed);
  const evicted = useSimStore((s) => s.evicted);
  const logs = useSimStore((s) => s.logs);
  const reservMode = useSimStore((s) => s.reservMode);
  const reservTarget = useSimStore((s) => s.reservTarget);
  const orgUsage = useSimStore((s) => s.orgUsage);
  const predictions = useSimStore((s) => s.predictions);

  const tick = useSimStore((s) => s.tick);
  const toggleRunning = useSimStore((s) => s.toggleRunning);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const reset = useSimStore((s) => s.reset);
  const loadScenario = useSimStore((s) => s.loadScenario);
  const enqueue = useSimStore((s) => s.enqueue);

  // Local UI state (modals)
  const [showAdd, setShowAdd] = useState(false);
  const [cfgOpen, { open: openCfg, close: closeCfg }] = useDisclosure(false);
  const [resultsOpen, { open: openResults, close: closeResults }] = useDisclosure(false);

  // Formula label for config summary
  const FORMULA_LABELS: Record<string, string> = {
    current_weighted: 'Current Weighted Score',
    normalized_weighted_sum: 'Normalized Weighted Sum',
    drf_fair_share: 'DRF Fair Share',
    balanced_composite: 'Balanced Composite (Deep Origin)',
    strict_fifo: 'Strict FIFO',
  };
  const formulaLabel = FORMULA_LABELS[normalizeFormulaType(cfg.formulaType ?? 'balanced_composite')] ?? 'Current Weighted Score';

  // Compute per-pool data for display (memoized).
  // Multi-pool jobs contribute their per-pool slice to each pool they touch
  // via `sumResourcesInPool`.
  const poolDisplayData = useMemo(
    () => cfg.cluster.pools.map((pool) => {
      const inUse = sumResourcesInPool(active, pool.type);
      const avail = sub3(
        sub3(pool.total, pool.reserved),
        inUse,
      );
      return {
        label: pool.label,
        total: pool.total,
        reserved: pool.reserved,
        inUse,
        avail,
      };
    }),
    [cfg, active],
  );

  return (
    <Box className={styles.root}>
      {/* Header */}
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Box>
          <Group gap={8}>
            <Text c="indigo.5" aria-hidden>⚙</Text>
            <Text size="xl" fw={700} c="grey.9">CRMQ Virtual Cluster Simulator</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={2}>
            Cost &amp; Resource Management Queue ·{' '}
            <Text component="a" href="https://deeporigin.atlassian.net/wiki/spaces/PLEN/pages/832897038" target="_blank" rel="noreferrer" c="indigo.5" size="xs" td="none" style={{ cursor: 'pointer' }}>
              Design Doc ↗
            </Text>
          </Text>
        </Box>
        <Group gap={8} wrap="wrap">
          <Text ff="monospace" className={styles.timeDisplay}>T = {fmtTime(simTime)}</Text>
          <select
            value={speed}
            onChange={(e) => setSpeed(+e.target.value)}
            className={styles.speedSelect}
          >
            <option value={1}>×1</option>
            <option value={5}>×5</option>
            <option value={10}>×10</option>
            <option value={30}>×30</option>
            <option value={60}>×60</option>
          </select>
          <Button variant="outline" color="indigo" size="compact-sm" onClick={() => tick(1)} disabled={running}>+1s</Button>
          <Button variant="outline" color="indigo" size="compact-sm" onClick={() => tick(10)} disabled={running}>+10s</Button>
          <Button
            size="compact-sm"
            variant="filled"
            onClick={toggleRunning}
            color={running ? 'yellow' : 'green'}
            fw={700}
          >
            {running ? '⏸ Pause' : '▶ Run'}
          </Button>
          <Button
            size="compact-sm"
            variant="outline"
            color="teal"
            onClick={openResults}
            disabled={completed.length === 0 && evicted.length === 0}
          >
            📊 Results
          </Button>
          <Button size="compact-sm" variant="outline" color="red" onClick={reset}>↺ Reset</Button>
        </Group>
      </Group>

      {/* Config summary bar — click to open detailed modal */}
      <Group
        gap="md"
        className={styles.configSummary}
        onClick={openCfg}
        style={{ cursor: 'pointer' }}
      >
        <Text size="xs" c="dimmed" fw={600}>Config:</Text>
        <Text size="xs" ff="monospace" c="grey.7">
          Formula: {formulaLabel}
        </Text>
        <Text size="xs" ff="monospace" c="grey.7">
          TopN: {cfg.scheduler.topN} · Reserv: {cfg.scheduler.reservationThresholdSec}s · Backfill: {cfg.scheduler.backfillMaxRatio}
        </Text>
        <Text size="xs" ff="monospace" c="grey.7">
          Pools:{' '}
          {cfg.cluster.pools
            .map(
              p =>
                `${p.shortLabel}(${vcpuFromCpuMillis(p.total.cpuMillis)}C)`
            )
            .join(', ')}
        </Text>
        <Text size="xs" ff="monospace" c="grey.7">
          Orgs: {orgs.length}
        </Text>
        <Text size="xs" c="indigo.5" fw={500}>View details ↗</Text>
      </Group>

      <ConfigSummaryModal opened={cfgOpen} onClose={closeCfg} cfg={cfg} orgs={orgs} />

      {/* Reservation mode banner */}
      {reservMode && (
        <Box className={styles.reservationBanner}>
          <Group gap="sm">
            <Box className={styles.pulseContainer}>
              <div className={styles.pulseRing} />
              <div className={styles.pulseDot} />
            </Box>
            <Text c="violet.6" fw={700} size="sm">RESERVATION MODE ACTIVE</Text>
            <Text c="violet.7" size="xs">
              Blocking new dispatches — accumulating for: <code className={styles.reservCode}>{reservTarget}</code>
            </Text>
          </Group>
        </Box>
      )}

      {/* Main grid */}
      <div className={styles.mainGrid}>
        <div className={styles.colLeft}>
          <Stack gap="sm">
            <ClusterPanel pools={poolDisplayData} />
            <OrgPanel orgs={orgs} orgUsage={orgUsage} pools={cfg.cluster.pools} cfg={cfg} />
          </Stack>
        </div>
        <div className={styles.colCenter}>
          <QueuePanel queue={queue} simTime={simTime} reservTarget={reservTarget}
            cfg={cfg} orgs={orgs} predictions={predictions}
            onAdd={() => setShowAdd(true)} onLoadScenario={loadScenario} />
        </div>
        <div className={styles.colRight}>
          <Stack gap="sm">
            <VCPredictionsPanel predictions={predictions} queue={queue} simTime={simTime} cfg={cfg} orgs={orgs} />
            <ActivePanel jobs={active} simTime={simTime} cfg={cfg} />
            <HistoryPanel completed={completed} evicted={evicted} />
          </Stack>
        </div>
      </div>

      <LogPanel logs={logs} />

      {showAdd && <AddJobModal cfg={cfg} orgs={orgs} onAdd={enqueue} onClose={() => setShowAdd(false)} />}

      <SimResultsModal
        opened={resultsOpen}
        onClose={closeResults}
        completed={completed}
        evicted={evicted}
        orgs={orgs}
        cfg={cfg}
        simTime={simTime}
      />

    </Box>
  );
};
