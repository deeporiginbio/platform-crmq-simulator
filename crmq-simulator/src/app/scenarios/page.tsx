/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Badge, Collapse, Divider, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { SCENARIO_PRESETS } from '@/lib/benchmark';
import type { ScenarioPreset, ArrivalPattern, JobSizeDistribution } from '@/lib/benchmark';

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmtDuration = (sec: number): string => {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(0)}d`;
};

const phaseMeta: Record<number, { label: string; color: string; description: string }> = {
  1: { label: 'Core', color: 'blue', description: 'Core scheduling scenarios that validate fundamental behavior' },
  2: { label: 'Advanced', color: 'violet', description: 'Multi-tenant fairness, GPU contention, and production-grade simulation' },
  4: { label: 'Stress', color: 'red', description: 'High-intensity scenarios that push scheduling mechanisms to their limits' },
  5: { label: 'Realistic', color: 'teal', description: 'Production-like patterns modeling real usage cycles and multi-step pipelines' },
  6: { label: 'Adversarial', color: 'pink', description: 'Game-theory scenarios testing formula exploitability and starvation bounds' },
};

// ── Cluster reference for calibration context ───────────────────────────────

const CLUSTER_INFO = {
  cpuPool: { label: 'mason (CPU)', cores: 1362, memory: 5457, gpu: 0 },
  gpuPool: { label: 'mason-gpu (GPU)', cores: 768, memory: 3072, gpu: 192 },
};

// ── Scenario deep-dive content ──────────────────────────────────────────────
// Why each scenario exists, what it tests, calibration rationale.

const DEEP_DIVE: Record<string, string[]> = {
  'steady-state': [
    'Heavy overload on the mason pool. Calibration: 30 jobs/min × avg 2.25 min duration = ~67.5 concurrent jobs × avg 32 CPU = ~2,160 CPU demand vs 1,362 available — ~159% oversubscription. Creates sustained queuing to stress-test dispatch and drain.',
    'Tests whether the scheduler can maintain high throughput without starving any org. The Poisson arrival process (memoryless property) means job arrivals are realistic and unpredictable.',
    'Expected behavior: persistent queue that fluctuates with Poisson variance. Backfilling should keep utilization near 100%. This is a benchmarkOnly infrastructure scenario — it validates dispatch mechanics, not formula differentiation.',
  ],
  'burst-traffic': [
    '200 jobs arrive simultaneously at t=0, saturating the cluster instantly. Total demand: ~200 × avg 40 CPU = ~8,000 CPU-units vs 1,362 available — a 6× oversubscription.',
    'Tests queue drain rate and whether the scheduler correctly prioritizes high-value jobs when everything is waiting. Also tests how quickly the cluster recovers to idle after the burst.',
    'Expected behavior: initial spike in wait times that decays exponentially as jobs complete. Formulas that handle priority well will show lower P95/P99 for high-priority jobs.',
  ],
  'mixed-workload': [
    'The 80/15/5 split creates a realistic job distribution. Small jobs (4–16 CPU) are backfill candidates, medium jobs (16–64 CPU) are standard workloads, and large jobs (64–256 CPU) create head-of-line blocking potential.',
    'Tests backfill effectiveness: when a large job is waiting for resources, can the scheduler fill the gap with small jobs? The mixed sizes create fragmentation — a classic bin-packing challenge.',
    'Expected behavior: small jobs have near-zero wait times (dispatched immediately via backfill). Large jobs wait longer. Good formulas minimize large-job wait without sacrificing small-job throughput.',
  ],
  'multi-tenant-competition': [
    'Asymmetric 3-org contention over 30 minutes. deeporigin submits 2 large 64-CPU jobs/min (384 CPU concurrent, ~28% of its 1,364 quota). org-beta floods 30 small 4-CPU jobs/min (240 CPU concurrent, within 384 quota). org-gamma submits 6 medium 32-CPU jobs/min (960 CPU demand, capped at 384 by quota). Combined demand: ~1,584 CPU vs 1,362 available.',
    'Tests org-level fairness under deliberate asymmetry. Each org has a different submission strategy: deeporigin uses few large jobs, org-beta uses many small ones, org-gamma hits its quota wall. The formula must allocate cluster resources fairly despite 15× volume difference (org-beta vs deeporigin).',
    'Key metrics: per-org wait time and throughput ratios. Good formulas give each org resources proportional to its quota share. org-gamma\'s queue should grow (demand exceeds quota) while org-beta\'s small jobs flow freely. deeporigin\'s large jobs should get priority via org weight.',
  ],
  'gpu-scarcity': [
    'Only 192 GPUs available across the cluster (mason-gpu pool). At 8 jobs/min with 4–16 GPU each, the GPU pool saturates within minutes: 8 × avg 10 GPU × avg 10 min = ~800 GPU-minutes/min demand vs 192 × 10 = 1920 GPU-minutes/min supply.',
    'Tests GPU-aware scheduling. CPU is abundant but GPU is scarce — the scheduler must route GPU jobs to mason-gpu and manage that bottleneck without blocking CPU-only work.',
    'Expected behavior: GPU jobs queue significantly. CPU utilization may drop if the scheduler incorrectly blocks CPU jobs waiting for GPU resources. Good formulas isolate the GPU bottleneck.',
  ],
  'head-of-line-blocking': [
    '95% small jobs (4–16 CPU) + 4% medium + 1% large (64–256 CPU, 2–8 GPU). The large jobs can require more resources than currently available, triggering reservation mode.',
    'Tests the interaction between reservation mode and backfilling. Without backfill, a single large job waiting for resources would block all 95% small jobs behind it — classic head-of-line blocking.',
    'Expected behavior: the scheduler enters reservation mode for large jobs (holding resources as they free up) while still dispatching small jobs via backfill. Throughput should remain high despite occasional large-job queuing.',
  ],
  'full-24h-simulation': [
    'Three orgs each submit medium-large jobs (96, 48, 64 CPU) plus background over 24 hours at ~105% cluster capacity. All three orgs compete for scarce pool capacity, with org-beta and org-gamma hitting their 384-CPU quota walls.',
    'Unlike the original design where a single org\'s massive job queued on capacity alone (making the formula irrelevant), this version creates genuine cross-org priority contention: when the pool is full, the formula must decide whether deeporigin\'s 96-CPU job or org-gamma\'s 64-CPU job gets the next slot.',
    'Key metric: formula differentiation. If all formulas still produce identical results, the bottleneck is purely mechanical (quota/capacity). The redesigned scenario ensures the scoring function is the tie-breaker, not just physics.',
  ],

  // Phase 4 — Stress Tests
  'queue-flood': [
    'org-beta floods 2,880 jobs (8 CPU, 30min each) every 30 seconds, saturating its 384-CPU quota with 48 running and ~12 always queued. deeporigin submits 128-CPU critical jobs hourly plus 32-CPU background every 5 min (~640 CPU). org-gamma pushes 32-CPU jobs every 4 min (480 demand, capped at 384). Total demand: ~1,408 CPU vs 1,362 available.',
    'The key test is priority isolation under combined queue volume AND resource pressure. All three orgs hit quota walls simultaneously, and total demand exceeds pool capacity. The formula must prioritize deeporigin\'s critical 128-CPU jobs over the flood while also giving org-gamma fair access.',
    'org-gamma remains the "collateral damage" indicator — if their wait times spike disproportionately during the flood, the formula is letting volume drown out priority. Good formulas show stable org-gamma wait times regardless of org-beta\'s 2,880-job flood.',
  ],
  'whale-blockade': [
    'The 768-CPU whale (56% of mason pool) arrives every 5 hours into ~768 CPU of background load: org-beta 384 (at quota cap), org-gamma 288, and deeporigin medium 96. Available capacity: 1,360 − 768 = 592 < 768. The whale physically cannot fit without draining background jobs.',
    'Tests reservation mode: after the whale is skipped 3+ times, it enters reservation mode — freed resources are held rather than given to new dispatches. Background jobs must complete (freeing ~16 CPU each) until 768 CPU accumulates. Small jobs should still backfill on remaining capacity.',
    'Key metric: whale wait time. The whale needs ~432 additional CPU freed. With 16-CPU background jobs completing every ~45–50 seconds, reservation mode should collect enough resources in ~20–40 minutes. If significantly longer, reservation mode or backfill is malfunctioning.',
  ],
  'gpu-famine': [
    'Runs entirely in the GPU pool (mason-gpu: 768 CPU, 192 GPU). The scoring formula uses CPU-based org-load, but the actual bottleneck is GPU count. This tests whether CPU-based scoring correctly reflects GPU-pool contention.',
    'Total GPU demand: deeporigin 120 × 32 GPU = 3,840 GPU-slots, org-beta 480 × 4 = 1,920, org-gamma 72 × 16 = 1,152. Total 6,912 GPU-slots vs 192 available — 36× oversubscribed. deeporigin alone requests 2× the entire GPU pool per cycle.',
    'Open question this scenario answers: since org-load tracks CPU usage within the pool (not GPU count), there may be a mismatch where an org appears "light" on CPU but is actually hoarding GPUs. If GPU utilization is high but fairness is poor, the formula may need a GPU-aware term.',
  ],
  'sustained-pareto-stress': [
    'Heavy Pareto load (α=1.5) at 18 jobs/min over 24 hours. Average job is ~24 CPU with ~3 min mean duration → ~54 concurrent × 24 CPU ≈ 1,296 CPU (~95% utilization). The Pareto tail produces 128-CPU outliers that tip the cluster into transient overload.',
    'At 95% baseline utilization, any tail-event (large CPU or long duration) pushes past capacity and creates a queue spike. These spikes trigger reservation mode, which must resolve quickly before the next outlier arrives. The cycle of spike→reservation→backfill→recovery repeats throughout the 24-hour run.',
    'Key metric: queue recovery time. After each large-job spike, how quickly does the queue return to manageable depth? The queue should oscillate (not grow monotonically) because average demand is below capacity — only the Pareto tail creates overload.',
  ],

  'cascading-failure': [
    'MMPP simulates failure-recovery cycles over 24 hours. Normal state (1/min, 45% of time, ~67% util) represents steady operations. Failure-burst state (4/min, 20%, ~270% util) represents resubmitted jobs after node crashes — ~120 jobs flood the queue in 30 minutes. Degraded state (0.2/min, 35%, ~13% util) is the quiet recovery period.',
    'State transitions every 30 minutes create recurring failure-recovery cycles. During bursts, the queue spikes dramatically and the scheduler must triage effectively — high-priority jobs dispatch first while low-priority ones queue. During degraded periods, the queue drains and the scheduler recovers to normal operating metrics.',
    'Key metric: recovery time — how many minutes after a burst does the queue return to manageable depth? Also measures fairness stability: do per-org wait time ratios stay consistent across normal and burst phases, or does one org disproportionately suffer during failures?',
  ],

  // Phase 5 — Realistic Production Workloads
  'monday-morning-rush': [
    'Models real-world usage with a Markov-Modulated Poisson Process (MMPP): night (0.5/min, 38% of time), regular day (1.5/min, 42%), and morning peak (3/min, 20%). State transitions every hour create realistic load cycling over 48 hours. Mixed 65/25/10 job sizes (E[CPU×dur] ≈ 38,280 CPU-sec/job, max throughput ≈ 2.1 jobs/min).',
    'Night: 0.5/min ≈ 25% utilization — queue drains freely. Day: 1.5/min ≈ 70% util — steady load with slight queuing. Peak: 3/min ≈ 140% util — queue builds significantly but safely drains during subsequent night phases.',
    'Expected pattern: night-time jobs run freely. Morning peak creates significant queues that partially drain during the regular day period. Day 2 should show similar patterns, validating that the scheduler reaches steady-state behavior across day/night cycles.',
  ],
  'dominant-tenant': [
    'org-beta submits 70% of all jobs (~504 small 4-CPU jobs/day) while deeporigin submits only 10% (~72 large 128-CPU jobs). Despite the volume asymmetry, both orgs contribute similar total CPU-hours: org-beta ≈ 504 × 4 × 0.25h = 504 CPU-hrs, deeporigin ≈ 72 × 128 × 4h = 36,864 CPU-hrs.',
    'Tests whether the org-load term correctly prevents the high-volume submitter from monopolizing queue positions. Without cluster-state awareness, org-beta\'s 504 jobs would crowd out deeporigin\'s 72 despite deeporigin consuming 73× more CPU-hours.',
    'The org CPU cap (org-beta: 384 CPU) is the primary defense — org-beta can never run more than 96 concurrent 4-CPU jobs. But the formula should also ensure deeporigin\'s large jobs don\'t wait unreasonably just because beta has more queue entries.',
  ],
  'mixed-multi-org': [
    'Diverse job types at ~100% cluster utilization. deeporigin: prep (8 CPU, every 5m) + compute (32 CPU, every 6m) + GPU (8 GPU, every 12m). org-beta: prep (16 CPU, every 5m) + compute (64 CPU, every 6m → 640 demand, capped at 384). org-gamma: analysis (16 CPU) + compute (32 CPU) + background (8 CPU) → 480 demand, capped at 384.',
    'Both org-beta and org-gamma hit their 384-CPU quota walls, creating real queue pressure. Combined running load: DO ~344 + beta 384 + gamma 384 ≈ 1,112 CPU (~82% util). Queued jobs from beta and gamma create scoring contention that the formula must resolve.',
    'Key metric: per-org wait time fairness across different job sizes. org-beta\'s 64-CPU compute jobs queue behind quota, while org-gamma\'s smaller 32-CPU and 8-CPU jobs compete for the same quota headroom. deeporigin\'s GPU jobs add cross-pool pressure.',
  ],

  'workflow-chains': [
    'Three concurrent pipelines at ~95% cluster util. MolProps (deeporigin): 20 prep/hr → 10 compute/hr → 5 GPU-finish/hr. Docking (org-beta): 20 prep/hr → 7.5 main/hr (64 CPU each, 480 demand capped at 384 by quota). Analysis (org-gamma): 20 prep/hr → 10 main/hr (32 CPU each) + background.',
    'org-beta\'s docking-main stage (64 CPU, every 8 min) exceeds its 384-CPU quota — 7.5 concurrent × 64 = 480 demand. ~1.5 jobs always queue, creating real scoring contention. org-gamma\'s combined analysis + background approaches its 384 quota at ~307 CPU. CPU pool total: ~1,051 running.',
    'Key test: cross-pool and cross-pipeline fairness. deeporigin\'s GPU-finish stage (8 GPU each, 10 concurrent = 80 GPU) competes in the mason-gpu pool while all other jobs use mason. The formula must balance pipeline stages — prep jobs should backfill around large compute jobs without starving any stage.',
  ],

  // Phase 6 — Adversarial & Game-Theory
  'job-splitting-attack': [
    'Background deeporigin load fills ~640 CPU (20 × 32-CPU '
    + 'jobs), then deeporigin submits 128-CPU honest jobs every '
    + '20 min (~6 concurrent = 768 CPU) while org-beta submits '
    + '4-CPU split jobs every 38 s (~384 CPU at quota cap). '
    + 'deeporigin delivers ~1,300+ CPU-hrs/hr (background + '
    + 'honest), org-beta delivers ~384 CPU-hrs/hr at quota cap.',
    'Total demand: ~1,792 CPU vs 1,362 cluster. deeporigin '
    + 'alone exceeds its 1,364 quota (640 + 768 = 1,408), so '
    + 'honest 128-CPU jobs queue. org-beta\'s 189 theoretical '
    + 'concurrent jobs are capped to 96 by the 384-CPU quota. '
    + 'Both orgs face real contention at Gate 1 and Gate 2.',
    'Key question: does splitting into many small jobs give '
    + 'org-beta a disproportionate share relative to its quota? '
    + 'If org-beta gets significantly more CPU-time than its '
    + '384-CPU quota share, small jobs game backfill. If '
    + 'deeporigin\'s large jobs wait unreasonably despite higher '
    + 'priority, reservation mode may be too aggressive. The '
    + 'org-load term should keep each org near its quota share.',
  ],
  'priority-inversion-stress': [
    'Three-layer saturation: org-gamma fills 384 CPU (24 × 16-CPU jobs at quota limit), org-beta fills 384 CPU (12 × 32-CPU jobs at quota limit), and deeporigin\'s own background fills ~576 CPU (18 × 32-CPU jobs). Total: ~1,344 of 1,362 CPU occupied — only ~18 CPU free.',
    'deeporigin\'s critical 256-CPU job arrives every ~4.8 hours and CANNOT fit. Without reservation mode, freed resources from completing jobs get immediately claimed by new background jobs from all three orgs. The 256-CPU job needs ~8 concurrent completions worth of headroom to dispatch.',
    'Reservation mode must activate: after the critical job is skipped 3+ times, freed resources are reserved (held) rather than given to new dispatches. This allows 256 CPUs to accumulate as jobs complete naturally, then the critical job dispatches. Key metric: how long does the critical job wait?',
  ],
  'priority-size-inversion': [
    'deeporigin (priority 3) floods 4-CPU jobs every 8 s '
    + '— 900 s / 8 s ≈ 113 concurrent × 4 CPU = 450 CPU '
    + 'steady-state. org-gamma (priority 1) submits '
    + '128-CPU jobs every 8 min — 14,400 s / 480 s = 30 '
    + 'concurrent demand, but only 3 fit within its '
    + '384-CPU quota (3 × 128 = 384). Queue of ~27 '
    + 'pending 128-CPU jobs builds up.',
    'org-beta provides a steady medium baseline at '
    + '16 CPU × 24 concurrent = 384 CPU (quota-limited). '
    + 'Total cluster demand: 450 + 384 + 384 = 1,218 of '
    + '1,362 CPU ≈ 89% utilisation. Enough headroom that '
    + 'DO\'s small jobs should never queue — IF the formula '
    + 'respects priority over job size.',
    'The critical test: when gamma\'s 128-CPU job '
    + 'triggers reservation mode (skipped 3+ times because '
    + 'cluster has only ~144 CPU free), does the scheduler '
    + 'block DO\'s small jobs while reserving for gamma? '
    + 'Good formulas should either (a) deprioritise '
    + 'low-priority large jobs so reservation triggers '
    + 'rarely, or (b) allow high-priority backfill around '
    + 'the reserved job.',
  ],
  'starvation-gauntlet': [
    'Absolute worst case for starvation: deeporigin streams 128-CPU jobs every 10 minutes (max priority 5/5), org-beta streams 64-CPU jobs every 10 minutes (high priority 4/4). Together they demand 144 × (128 + 64) = 27,648 CPU-units over 24h — far exceeding capacity.',
    'org-gamma submits a SINGLE 16-CPU job at the start with minimum priority (1/1). This job requires only 1.2% of cluster capacity but faces a 5× priority disadvantage and zero queue-position advantage. Without aging, it would never run.',
    'The aging mechanism must overcome the priority differential: with logarithmic aging (τ × 2^(P_max/C) − 1), the org-gamma job should reach competitive priority within a bounded time. This scenario empirically measures that starvation bound — the maximum wait time any job should ever experience.',
  ],
  'oscillating-demand': [
    'Rapid MMPP cycling every 15 minutes between three states: micro-burst (7 jobs/min = 420/hr, creating instant queue buildup), heavy-batch (0.2 jobs/min = 12/hr, just a few large jobs), and silence (0.02 jobs/min ≈ 1/hr, near-zero load). The pattern tests formula stability under whiplash-like load changes.',
    'The uniform job-size distribution (2–256 CPU, 5m–2h) creates maximum variance. During micro-bursts, 105 small-to-large jobs arrive in 15 minutes — the queue builds rapidly. During silence, the cluster drains. The oscillation prevents any steady-state from forming.',
    'Key metric: score stability. If the org-load term oscillates wildly between burst/quiet phases, scores will "thrash" — a job\'s priority ranking may flip repeatedly. Good formulas dampen this oscillation (e.g., EMA smoothing on org-load) to maintain stable scheduling decisions.',
  ],
};

// ── Arrival Pattern Description ─────────────────────────────────────────────

const ArrivalInfo = ({ pattern }: { pattern: ArrivalPattern }) => {
  switch (pattern.type) {
    case 'poisson':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="filled" color="cyan">Poisson</Badge>
            <Text size="xs" ff="monospace" fw={600}>{pattern.lambdaPerMinute} jobs/min</Text>
          </Group>
          <Text size="xs" c="dimmed">
            Memoryless exponential inter-arrival times — the standard model for realistic, unpredictable traffic.
            Average inter-arrival gap: {(60 / pattern.lambdaPerMinute).toFixed(1)}s.
          </Text>
        </Box>
      );
    case 'burst':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="filled" color="red">Burst</Badge>
            <Text size="xs" ff="monospace" fw={600}>{pattern.count} jobs at t={pattern.atTime}s</Text>
          </Group>
          <Text size="xs" c="dimmed">
            All jobs arrive simultaneously — instant queue saturation. Tests peak-load handling and queue drain.
          </Text>
        </Box>
      );
    case 'uniform':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="filled" color="green">Uniform</Badge>
            <Text size="xs" ff="monospace" fw={600}>{pattern.ratePerMinute} jobs/min</Text>
          </Group>
          <Text size="xs" c="dimmed">
            Constant inter-arrival times (deterministic). Used as a baseline — no randomness in arrivals.
          </Text>
        </Box>
      );
    case 'mmpp':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="filled" color="orange">MMPP</Badge>
            <Text size="xs" ff="monospace" fw={600}>{pattern.states.length} states</Text>
          </Group>
          <Text size="xs" c="dimmed" mb="xs">
            Markov-Modulated Poisson Process — rate switches between states every {fmtDuration(pattern.transitionInterval)}.
            Models realistic burstiness with correlated traffic.
          </Text>
          <Table withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs">State</Text></Table.Th>
                <Table.Th><Text size="xs">Rate</Text></Table.Th>
                <Table.Th><Text size="xs">Weight</Text></Table.Th>
                <Table.Th><Text size="xs">Avg time in state</Text></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {pattern.states.map(s => (
                <Table.Tr key={s.label}>
                  <Table.Td><Text size="xs" fw={500}>{s.label}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{s.lambdaPerMinute} jobs/min</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{(s.weight * 100).toFixed(0)}%</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">~{fmtDuration(pattern.transitionInterval * s.weight)}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      );
    case 'periodic_mix':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="filled" color="violet">Periodic Mix</Badge>
            <Text size="xs" ff="monospace" fw={600}>{pattern.templates.length} templates</Text>
          </Group>
          <Text size="xs" c="dimmed" mb="xs">
            Deterministic: each template generates jobs at a fixed interval with ±5% jitter for replication variance.
          </Text>
        </Box>
      );
  }
};

// ── Size Distribution Description ───────────────────────────────────────────

const SizeInfo = ({ dist, preset }: { dist: JobSizeDistribution; preset: ScenarioPreset }) => {
  switch (dist.type) {
    case 'uniform':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="outline" color="grey">Uniform</Badge>
          </Group>
          <Table withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs">Resource</Text></Table.Th>
                <Table.Th><Text size="xs">Min</Text></Table.Th>
                <Table.Th><Text size="xs">Max</Text></Table.Th>
                <Table.Th><Text size="xs">Avg</Text></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Text size="xs" fw={500}>CPU (cores)</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{dist.cpuRange[0]}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{dist.cpuRange[1]}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{((dist.cpuRange[0] + dist.cpuRange[1]) / 2).toFixed(0)}</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs" fw={500}>Memory (GB)</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{dist.memoryRange[0]}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{dist.memoryRange[1]}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{((dist.memoryRange[0] + dist.memoryRange[1]) / 2).toFixed(0)}</Text></Table.Td>
              </Table.Tr>
              {dist.gpuRange[1] > 0 && (
                <Table.Tr>
                  <Table.Td><Text size="xs" fw={500}>GPU</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{dist.gpuRange[0]}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{dist.gpuRange[1]}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{((dist.gpuRange[0] + dist.gpuRange[1]) / 2).toFixed(0)}</Text></Table.Td>
                </Table.Tr>
              )}
              <Table.Tr>
                <Table.Td><Text size="xs" fw={500}>Duration</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{fmtDuration(dist.durationRange[0])}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{fmtDuration(dist.durationRange[1])}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{fmtDuration((dist.durationRange[0] + dist.durationRange[1]) / 2)}</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Box>
      );

    case 'mixed':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="outline" color="grey">Mixed (3-class)</Badge>
          </Group>
          <Text size="xs" c="dimmed" mb="xs">
            Calibrated for a ~1,362 CPU cluster. Small jobs are backfill candidates, large jobs create contention.
          </Text>
          <Table withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs">Class</Text></Table.Th>
                <Table.Th><Text size="xs">Frequency</Text></Table.Th>
                <Table.Th><Text size="xs">CPU</Text></Table.Th>
                <Table.Th><Text size="xs">Memory (GB)</Text></Table.Th>
                <Table.Th><Text size="xs">GPU</Text></Table.Th>
                <Table.Th><Text size="xs">Duration</Text></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Badge size="xs" variant="light" color="green">Small</Badge></Table.Td>
                <Table.Td><Text size="xs" ff="monospace" fw={600}>{dist.small}%</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">4–16</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">16–64</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">0</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">1–3m</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Badge size="xs" variant="light" color="yellow">Medium</Badge></Table.Td>
                <Table.Td><Text size="xs" ff="monospace" fw={600}>{dist.medium}%</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">16–64</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">64–256</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">0–2</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">3–10m</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Badge size="xs" variant="light" color="red">Large</Badge></Table.Td>
                <Table.Td><Text size="xs" ff="monospace" fw={600}>{dist.large}%</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">64–256</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">256–1024</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">2–8</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">10–60m</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Box>
      );

    case 'pareto':
      return (
        <Box>
          <Group gap="xs" mb={4}>
            <Badge size="xs" variant="outline" color="grey">Pareto (heavy-tailed)</Badge>
            <Text size="xs" ff="monospace">α = {dist.alpha}</Text>
          </Group>
          <Text size="xs" c="dimmed" mb="xs">
            Heavy-tailed: most jobs are near the minimum, but rare outliers can be massive.
            With α=1.5, the mean is 3× the minimum and variance is infinite — extreme outliers are expected.
            Values are capped at 128 CPU / 512 GB / 16 GPU / 8h to prevent unbounded resources.
          </Text>
          <Table withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs">Resource</Text></Table.Th>
                <Table.Th><Text size="xs">Minimum</Text></Table.Th>
                <Table.Th><Text size="xs">Theoretical Mean</Text></Table.Th>
                <Table.Th><Text size="xs">Cap</Text></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td><Text size="xs" fw={500}>CPU</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{dist.cpuMin}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{(dist.cpuMin * dist.alpha / (dist.alpha - 1)).toFixed(0)}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">128</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs" fw={500}>Memory (GB)</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{dist.memoryMin}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{(dist.memoryMin * dist.alpha / (dist.alpha - 1)).toFixed(0)}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">512</Text></Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td><Text size="xs" fw={500}>Duration</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{fmtDuration(dist.durationMin)}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{fmtDuration(dist.durationMin * dist.alpha / (dist.alpha - 1))}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">8h</Text></Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Box>
      );

    case 'fixed':
      // periodic_mix uses fixed as placeholder — skip
      return null;
  }
};

// ── Periodic Mix Template Table ─────────────────────────────────────────────

const PeriodicMixInfo = ({ preset }: { preset: ScenarioPreset }) => {
  const wc = preset.workloadConfig;
  if (wc.arrivalPattern.type !== 'periodic_mix') return null;
  const templates = wc.arrivalPattern.templates;

  // Per-org aggregation
  const orgSummary: Record<string, { jobs: number; totalCpu: number; totalMemory: number; templates: string[] }> = {};
  for (const t of templates) {
    const count = Math.floor(wc.durationSeconds / t.intervalSeconds);
    if (!orgSummary[t.orgId]) orgSummary[t.orgId] = { jobs: 0, totalCpu: 0, totalMemory: 0, templates: [] };
    orgSummary[t.orgId].jobs += count;
    orgSummary[t.orgId].totalCpu += count * t.cpu;
    orgSummary[t.orgId].totalMemory += count * t.memory;
    orgSummary[t.orgId].templates.push(t.name);
  }

  const totalJobs = Object.values(orgSummary).reduce((s, o) => s + o.jobs, 0);

  return (
    <Stack gap="sm">
      <Box>
        <Text size="xs" fw={500} c="grey.7" mb={4}>Job Templates ({templates.length} types, ~{totalJobs} total jobs)</Text>
        <Table withTableBorder withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th><Text size="xs">Job Type</Text></Table.Th>
              <Table.Th><Text size="xs">Org</Text></Table.Th>
              <Table.Th><Text size="xs">CPU</Text></Table.Th>
              <Table.Th><Text size="xs">Memory</Text></Table.Th>
              <Table.Th><Text size="xs">GPU</Text></Table.Th>
              <Table.Th><Text size="xs">Duration</Text></Table.Th>
              <Table.Th><Text size="xs">Arrives Every</Text></Table.Th>
              <Table.Th><Text size="xs">Total Count</Text></Table.Th>
              <Table.Th><Text size="xs">CPU-hrs Total</Text></Table.Th>
              <Table.Th><Text size="xs">User Prio</Text></Table.Th>
              <Table.Th><Text size="xs">Tool Prio</Text></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {templates.map(t => {
              const count = Math.floor(wc.durationSeconds / t.intervalSeconds);
              const cpuHours = (count * t.cpu * t.durationSeconds / 3600).toFixed(0);
              return (
                <Table.Tr key={t.name}>
                  <Table.Td><Text size="xs" fw={500}>{t.name}</Text></Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light" color={
                      t.orgId === 'deeporigin' ? 'blue' :
                      t.orgId === 'org-beta' ? 'green' : 'orange'
                    }>{t.orgId}</Badge>
                  </Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{t.cpu}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{t.memory} GB</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{t.gpu}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{fmtDuration(t.durationSeconds)}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{fmtDuration(t.intervalSeconds)}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace" fw={600}>{count}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{Number(cpuHours).toLocaleString()}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{t.userPriority}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{t.toolPriority}</Text></Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Box>

      <Box>
        <Text size="xs" fw={500} c="grey.7" mb={4}>Per-Org Resource Demand</Text>
        <Table withTableBorder withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th><Text size="xs">Org</Text></Table.Th>
              <Table.Th><Text size="xs">Job Types</Text></Table.Th>
              <Table.Th><Text size="xs">Total Jobs</Text></Table.Th>
              <Table.Th><Text size="xs">Total CPU-units</Text></Table.Th>
              <Table.Th><Text size="xs">Total Memory (GB)</Text></Table.Th>
              <Table.Th><Text size="xs">% of Jobs</Text></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Object.entries(orgSummary).map(([orgId, s]) => (
              <Table.Tr key={orgId}>
                <Table.Td>
                  <Badge size="xs" variant="light" color={
                    orgId === 'deeporigin' ? 'blue' :
                    orgId === 'org-beta' ? 'green' : 'orange'
                  }>{orgId}</Badge>
                </Table.Td>
                <Table.Td><Text size="xs">{s.templates.join(', ')}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace" fw={600}>{s.jobs}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{s.totalCpu.toLocaleString()}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{s.totalMemory.toLocaleString()}</Text></Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{(s.jobs / totalJobs * 100).toFixed(1)}%</Text></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Stack>
  );
};

// ── Estimated Job Count ─────────────────────────────────────────────────────

const estimateJobCount = (preset: ScenarioPreset): number => {
  const { arrivalPattern, durationSeconds } = preset.workloadConfig;
  switch (arrivalPattern.type) {
    case 'poisson': return Math.round(arrivalPattern.lambdaPerMinute * (durationSeconds / 60));
    case 'uniform': return Math.round(arrivalPattern.ratePerMinute * (durationSeconds / 60));
    case 'burst': return arrivalPattern.count;
    case 'mmpp': {
      const avgRate = arrivalPattern.states.reduce((s, st) => s + st.lambdaPerMinute * st.weight, 0);
      return Math.round(avgRate * (durationSeconds / 60));
    }
    case 'periodic_mix':
      return arrivalPattern.templates.reduce((s, t) => s + Math.floor(durationSeconds / t.intervalSeconds), 0);
  }
};

// ── Single Scenario Card ────────────────────────────────────────────────────

const ScenarioCard = ({ preset }: { preset: ScenarioPreset }) => {
  const [expanded, setExpanded] = useState(false);
  const [deepDive, setDeepDive] = useState(false);
  const wc = preset.workloadConfig;
  const jobCount = estimateJobCount(preset);
  const phase = phaseMeta[preset.phase];
  const diveContent = DEEP_DIVE[preset.id];

  return (
    <Box
      p="md"
      style={{
        border: '1px solid #E5E7EA',
        borderRadius: 12,
        background: expanded ? '#FAFBFC' : '#fff',
        transition: 'background 0.15s',
      }}
    >
      {/* Collapsed header — always visible */}
      <Group
        justify="space-between"
        style={{ cursor: 'pointer' }}
        onClick={() => setExpanded(v => !v)}
      >
        <Group gap="sm">
          <Text size="md" fw={700} c={preset.benchmarkOnly ? 'dimmed' : 'grey.9'}>{preset.name}</Text>
          <Badge size="xs" variant="light" color={phase.color}>{phase.label}</Badge>
          {preset.benchmarkOnly && (
            <Tooltip
              label="Infrastructure validation only — not available in simulator"
              withArrow
              multiline
              w={220}
            >
              <Badge size="xs" variant="outline" color="grey">INFRA TEST ONLY</Badge>
            </Tooltip>
          )}
          <Badge size="xs" variant="outline" color="grey">~{jobCount.toLocaleString()} jobs</Badge>
          <Badge size="xs" variant="outline" color="grey">{fmtDuration(wc.durationSeconds)}</Badge>
          <Badge size="xs" variant="outline" color="grey">seed: {wc.seed}</Badge>
        </Group>
        <Text size="xs" c="dimmed" style={{ userSelect: 'none' }}>
          {expanded ? '▾ collapse' : '▸ expand'}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>{preset.description}</Text>

      <Collapse in={expanded}>
        <Divider my="sm" />
        <Stack gap="md">
          {/* Arrival pattern */}
          <Box>
            <Text size="sm" fw={600} c="grey.8" mb="xs">Arrival Pattern</Text>
            <ArrivalInfo pattern={wc.arrivalPattern} />
          </Box>

          {/* Job size distribution */}
          {wc.arrivalPattern.type !== 'periodic_mix' && (
            <Box>
              <Text size="sm" fw={600} c="grey.8" mb="xs">Job Size Distribution</Text>
              <SizeInfo dist={wc.sizeDistribution} preset={preset} />
            </Box>
          )}

          {/* Periodic mix templates */}
          {wc.arrivalPattern.type === 'periodic_mix' && (
            <Box>
              <Text size="sm" fw={600} c="grey.8" mb="xs">Job Templates & Frequency</Text>
              <PeriodicMixInfo preset={preset} />
            </Box>
          )}

          {/* Deep dive toggle */}
          {diveContent && (
            <Box>
              <Text
                size="xs"
                fw={500}
                c="indigo.5"
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onClick={(e) => { e.stopPropagation(); setDeepDive(v => !v); }}
              >
                {deepDive ? '▾ Hide' : '▸ Show'} Deep Dive — Why this scenario exists
              </Text>
              <Collapse in={deepDive}>
                <Box mt="xs" p="sm" style={{ background: '#F5F3FF', borderRadius: 8, border: '1px solid #E0DAFB' }}>
                  <Stack gap="xs">
                    {diveContent.map((para, i) => (
                      <Text key={i} size="xs" c="grey.8" style={{ lineHeight: 1.6 }}>{para}</Text>
                    ))}
                  </Stack>
                </Box>
              </Collapse>
            </Box>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
};

// ── Page Component ──────────────────────────────────────────────────────────

const ScenariosPage = () => {
  const phases = [1, 2, 4, 5, 6] as const;

  return (
    <Box p="md">
      <Stack gap="lg">
        {/* Header */}
        <Box>
          <Text size="xl" fw={700} c="grey.9">Scenario Catalog</Text>
          <Text size="xs" c="dimmed" mt={2}>
            {SCENARIO_PRESETS.length} benchmark scenarios — click any scenario to see full details
          </Text>
        </Box>

        {/* Cluster reference */}
        <Box p="sm" style={{ background: '#F0F4FF', border: '1px solid #C7D2FE', borderRadius: 8 }}>
          <Text size="xs" fw={600} c="indigo.7" mb={4}>Cluster Reference (all scenarios calibrated against this)</Text>
          <Group gap="lg">
            <Box>
              <Text size="xs" fw={500} c="grey.7">{CLUSTER_INFO.cpuPool.label}</Text>
              <Text size="xs" ff="monospace">{CLUSTER_INFO.cpuPool.cores.toLocaleString()} cores · {CLUSTER_INFO.cpuPool.memory.toLocaleString()} GB memory</Text>
            </Box>
            <Box>
              <Text size="xs" fw={500} c="grey.7">{CLUSTER_INFO.gpuPool.label}</Text>
              <Text size="xs" ff="monospace">{CLUSTER_INFO.gpuPool.cores} cores · {CLUSTER_INFO.gpuPool.memory.toLocaleString()} GB memory · {CLUSTER_INFO.gpuPool.gpu} GPUs</Text>
            </Box>
            <Box>
              <Text size="xs" fw={500} c="grey.7">Orgs</Text>
              <Text size="xs" ff="monospace">deeporigin (pri 3) · org-beta (pri 2) · org-gamma (pri 1)</Text>
            </Box>
          </Group>
        </Box>

        {/* Scenarios grouped by phase */}
        {phases.map(phase => {
          const meta = phaseMeta[phase];
          const presets = SCENARIO_PRESETS.filter(p => p.phase === phase);
          if (presets.length === 0) return null;
          return (
            <Box key={phase}>
              <Group gap="sm" mb="sm">
                <Badge size="sm" variant="filled" color={meta.color}>{meta.label}</Badge>
                <Text size="xs" c="dimmed">{meta.description}</Text>
              </Group>
              <Stack gap="sm">
                {presets.map(p => (
                  <ScenarioCard key={p.id} preset={p} />
                ))}
              </Stack>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
};

export default ScenariosPage;
