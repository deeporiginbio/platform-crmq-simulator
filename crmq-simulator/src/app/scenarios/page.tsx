/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Badge, Collapse, Divider, Group, Stack, Table, Text, ThemeIcon } from '@mantine/core';
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
  1: { label: 'Phase 1 — MVP', color: 'blue', description: 'Core scheduling scenarios that validate fundamental behavior' },
  2: { label: 'Phase 2 — Advanced', color: 'indigo', description: 'Multi-tenant fairness, GPU contention, and dynamic load patterns' },
  3: { label: 'Phase 3 — Edge Cases', color: 'violet', description: 'Extreme distributions, resource exhaustion, and production-grade simulation' },
  4: { label: 'Stress Tests', color: 'red', description: 'High-intensity edge cases that push scheduling mechanisms to their limits' },
  5: { label: 'Realistic Workloads', color: 'teal', description: 'Production-like patterns modeling real usage cycles and multi-step pipelines' },
  6: { label: 'Adversarial', color: 'orange', description: 'Game-theory scenarios testing formula exploitability and starvation bounds' },
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
    'Targets ~80% CPU utilization on the mason pool. Calibration: 30 jobs/min × avg 32 CPU per job = ~960 concurrent CPU-units needed. With 1362 available cores and ~2 min avg duration, this creates sustained but manageable queuing.',
    'Tests whether the scheduler can maintain high throughput without starving any org. The Poisson arrival process (memoryless property) means job arrivals are realistic and unpredictable.',
    'Expected behavior: short, steady wait times with good fairness across orgs. Backfilling should keep utilization high. This is the "golden path" scenario — if a formula fails here, it fails everywhere.',
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
  'priority-inversion': [
    '150 jobs burst with random priorities (1–5). When all jobs arrive simultaneously, the scheduler must correctly order them by priority rather than FIFO.',
    'Tests the aging mechanism: without aging, low-priority jobs could wait indefinitely while high-priority jobs keep arriving (in longer scenarios). Here, the burst ensures the priority ladder is exercised.',
    'Expected behavior: priority 5 jobs dispatch first, priority 1 jobs last. The wait-time spread between priority levels measures how well the formula respects priority. Aging should eventually rescue starved jobs.',
  ],
  'multi-tenant-competition': [
    '3 orgs (deeporigin, org-beta, org-gamma) compete for shared resources. deeporigin has the largest quota (1364 CPU), while beta and gamma share 384 CPU each.',
    'Tests org-level fairness under contention. When total demand exceeds supply, does each org get its fair share proportional to its quota? The DRF and Balanced Composite formulas are specifically designed for this.',
    'Expected behavior: Jain\'s Fairness Index should be near 1.0 for resource-aware formulas. Simple weighted scoring may favor whichever org happens to submit jobs first.',
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
  'ramp-up-down': [
    'MMPP (Markov-Modulated Poisson Process) cycles through 3 states: quiet (5/min, 30% weight), busy (30/min, 50% weight), peak (60/min, 20% weight). State transitions every 10 minutes.',
    'Tests adaptability to changing load. The scheduler must handle both under-utilization (quiet periods) and over-saturation (peak bursts) gracefully. This is the most realistic arrival pattern for production workloads.',
    'Expected behavior: wait times spike during peak phases and recover during quiet phases. Good formulas maintain fairness even when load oscillates dramatically.',
  ],
  'heavy-tailed': [
    'Pareto distribution (α=1.5) generates extreme size variance. Most jobs are small, but occasional massive outliers can demand 128 CPU + 512 GB + 16 GPU for up to 8 hours.',
    'Tests robustness to extreme variance. The "80/20 rule" applies: 80% of resource consumption comes from 20% of jobs. The scheduler must handle these outliers without destabilizing the rest of the queue.',
    'Expected behavior: highly variable wait times. The coefficient of variation (CoV) metric is key here — good formulas keep CoV low despite the extreme input variance.',
  ],
  'zero-headroom': [
    '300 massive jobs arrive at once. Each demands 32–128 CPU, 128–512 GB memory, 0–4 GPU, and runs 10–30 minutes. Total demand: ~300 × avg 80 CPU = ~24,000 CPU-units vs 1,362 available — 18× oversubscription.',
    'Tests TTL eviction. When jobs wait too long in queue, they should be evicted (respecting TTL) rather than clogging the system indefinitely. This scenario pushes the eviction mechanism to its limits.',
    'Expected behavior: high eviction rates. The system must prioritize the most valuable jobs and gracefully evict the rest. Formulas that handle this well show controlled eviction patterns rather than random drops.',
  ],
  'full-24h-simulation': [
    'Deterministic workload using 6 fixed job templates across 3 orgs. Templates repeat at fixed intervals (3–10 minutes) over 24 hours, producing ~1,695 total jobs. A ±5% arrival jitter prevents identical replications.',
    'Tests production-like scheduling over a full day cycle. The mix includes a massive job (TypeA: 192 CPU, 6hr duration) that dominates deeporigin\'s allocation, alongside many small background jobs.',
    'The TypeA job is particularly interesting: at 192 CPU every 5 minutes with a 6-hour duration, multiple instances overlap — up to ~72 concurrent TypeA jobs consuming 192 × 72 = 13,824 CPU-minutes/hr. This exceeds deeporigin\'s quota, creating sustained reservation-mode pressure.',
  ],

  // Phase 4 — Stress Tests
  'queue-flood': [
    'Models a denial-of-service-like scenario: org-beta floods the queue with ~2,009 tiny jobs (2 CPU, 5m each) arriving every 43 seconds. Meanwhile, deeporigin submits 20 critical large jobs (128 CPU, 2h each) every 72 minutes — these represent high-value work that must not be drowned.',
    'The key test is priority isolation under queue pressure. Total org-beta CPU demand: 2,009 × 2 = 4,018 CPU-units, but they\'re capped at 400 CPU. Total deeporigin demand: 20 × 128 = 2,560 CPU-units. The formula must ensure deeporigin\'s large jobs get scheduled ahead of the flood despite org-beta having 100× more queue entries.',
    'org-gamma (240 medium 16-CPU jobs) is the "collateral damage" indicator — if their wait times spike during the flood, the formula is letting the flood affect innocent bystanders. Good formulas should show flat org-gamma wait times regardless of org-beta\'s flood volume.',
  ],
  'whale-blockade': [
    'A single job demands 768 CPU — 56% of the entire mason pool (1,362 cores). This physically cannot run alongside normal operations. The whale must wait until enough jobs complete to free 768 CPUs, then claim them all.',
    'Tests the reservation mode mechanism: after N scheduling cycles where the whale is skipped, it should enter reservation mode, where freed resources are held rather than given to smaller jobs. During this time, smaller jobs should still backfill on the remaining ~596 CPUs.',
    'The whale wait time is the key metric — it measures the starvation bound for the largest possible job. With 200 background small jobs (8–12 CPU, 15–20m) cycling, resources should free up within ~1–2 hours. If the whale waits significantly longer, reservation mode or backfilling is malfunctioning.',
  ],
  'gpu-famine': [
    'Runs entirely in the GPU pool (mason-gpu: 768 CPU, 192 GPU). The scoring formula uses CPU-based org-load, but the actual bottleneck is GPU count. This tests whether CPU-based scoring correctly reflects GPU-pool contention.',
    'Total GPU demand: deeporigin 120 × 32 GPU = 3,840 GPU-slots, org-beta 480 × 4 = 1,920, org-gamma 72 × 16 = 1,152. Total 6,912 GPU-slots vs 192 available — 36× oversubscribed. deeporigin alone requests 2× the entire GPU pool per cycle.',
    'Open question this scenario answers: since org-load tracks CPU usage within the pool (not GPU count), there may be a mismatch where an org appears "light" on CPU but is actually hoarding GPUs. If GPU utilization is high but fairness is poor, the formula may need a GPU-aware term.',
  ],
  'cascading-failure': [
    'Models sustained load with Pareto-distributed job sizes (α=1.5), producing extreme variance. At 25 jobs/hr (~0.42/min), the cluster sees a mix of tiny and massive jobs. The Pareto distribution means ~80% of resource consumption comes from ~20% of jobs.',
    'Note: the full scenario from the report includes mid-simulation events (killing 30% of running jobs at t=6h, 20% at t=12h, reducing capacity at t=18h). These events require DES engine extensions not yet implemented. The current version tests the heavy-tailed load dynamics only.',
    'Even without explicit failure events, the Pareto load creates natural "cascading" behavior: when a massive outlier job finally completes, it releases a burst of resources that triggers rapid queue drain — similar to a failure-recovery pattern.',
  ],

  // Phase 5 — Realistic Production Workloads
  'monday-morning-rush': [
    'Models real-world usage with a Markov-Modulated Poisson Process (MMPP): night shift (5 jobs/hr, 38% of time), regular day (35 jobs/hr, 42%), and morning peak (70 jobs/hr, 20%). State transitions every hour create realistic load cycling over 48 hours.',
    'The 65/25/10 mixed job sizes (small/medium/large) represent a real platform: small jobs are interactive notebooks and quick analyses, medium jobs are pipeline runs, and large jobs are full docking or training workloads.',
    'Expected pattern: night-time jobs run freely on idle cluster. Morning peak creates a queue that gradually drains during the regular day period. Day 2 should show similar patterns, validating that the scheduler reaches steady-state behavior.',
  ],
  'dominant-tenant': [
    'org-beta submits 70% of all jobs (~504 small 4-CPU jobs/day) while deeporigin submits only 10% (~72 large 128-CPU jobs). Despite the volume asymmetry, both orgs contribute similar total CPU-hours: org-beta ≈ 504 × 4 × 0.25h = 504 CPU-hrs, deeporigin ≈ 72 × 128 × 4h = 36,864 CPU-hrs.',
    'Tests whether the org-load term correctly prevents the high-volume submitter from monopolizing queue positions. Without cluster-state awareness, org-beta\'s 504 jobs would crowd out deeporigin\'s 72 despite deeporigin consuming 73× more CPU-hours.',
    'The org CPU cap (org-beta: 400 CPU) is the primary defense — org-beta can never run more than 100 concurrent 4-CPU jobs. But the formula should also ensure deeporigin\'s large jobs don\'t wait unreasonably just because beta has more queue entries.',
  ],
  'workflow-chains': [
    'Models three concurrent pipeline types: MolProps (CPU prep → CPU main → GPU finish), Docking (CPU-CPU), and Analysis (lightweight CPU-only), each producing 5 workflows/hour plus background standalone jobs.',
    'Note: the simulator does not yet support true sequential dependencies. Steps are modeled as independent jobs arriving at the same rate. The resource profile is faithful — each step has the correct CPU/memory/GPU — but they run independently rather than sequentially.',
    'The MolProps pipeline is the most interesting: its Step 3 requires 8 GPUs, meaning it enters the GPU pool queue. In the full implementation, this step would inherit its workflow\'s accumulated age from the CPU pool. This scenario establishes the resource-demand baseline for when workflow support is added.',
  ],

  // Phase 6 — Adversarial & Game-Theory
  'job-splitting-attack': [
    'A controlled fairness experiment: deeporigin and org-beta both need 5,120 CPU-hours of work done. deeporigin submits honestly (10 × 128 CPU × 4h), while org-beta splits into 320 × 4 CPU × 4h. Same work, different packaging.',
    'If the formula is fair, both orgs should receive approximately equal total CPU-hours (±10%). If org-beta gets significantly more, the formula rewards job-splitting. If deeporigin gets more, the formula penalizes it (large-job bias).',
    'The org-load term is critical here: as org-beta\'s many small jobs consume CPU, the (1 - orgLoad) term should throttle further org-beta dispatches, equalizing with deeporigin. Without this term, org-beta\'s 320 queue entries would dominate the scheduling queue.',
  ],
  'priority-inversion-stress': [
    'Creates deep priority inversion: org-gamma (mid-priority) fills 90% of the cluster with 32-CPU jobs, then deeporigin (highest priority) submits 5 critical 256-CPU jobs that physically cannot fit. Meanwhile, org-beta (lowest priority) keeps submitting tiny 4-CPU jobs that CAN fit in the remaining gaps.',
    'The critical test: does the scheduler let org-beta\'s small jobs "steal" the resources deeporigin needs? Without reservation mode, every time a gamma job completes and frees 32 CPUs, org-beta\'s tiny jobs could grab those 32 CPUs before deeporigin can accumulate 256 CPUs.',
    'Reservation mode should activate: once deeporigin\'s 256-CPU job is skipped N times, freed resources are reserved (held) rather than given to new jobs. This allows 256 CPUs to accumulate over ~8 gamma-job completions, then the critical job dispatches.',
  ],
  'ttl-expiry-cascade': [
    'Deliberate sustained overload: 60 jobs/hr with mixed sizes (50% small, 35% medium, 15% large) against a 1,362-CPU cluster. With an average job size of ~25 CPU and ~45 min duration, steady-state demand ≈ 45 concurrent jobs × 25 CPU = 1,125 CPU, close to capacity.',
    'The 2-hour TTL creates a cascade effect: after the first 2 hours, jobs that never got scheduled start expiring, freeing queue slots. This creates a "wave" pattern where new jobs compete with the drainage of expired entries. The system should reach equilibrium where arrivals ≈ completions + evictions.',
    'Key insight: the 15% large jobs (64–256 CPU) are most likely to expire, since they\'re hardest to schedule. This means the eviction pattern is not random — it selectively removes the largest jobs, which could skew the running workload toward small jobs. The formula should counteract this bias.',
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
          <Text size="md" fw={700} c="grey.9">{preset.name}</Text>
          <Badge size="xs" variant="light" color={phase.color}>{phase.label}</Badge>
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
  // Group by phase
  const phases = [1, 2, 3, 4, 5, 6] as const;

  return (
    <Box p="md">
      <Stack gap="lg">
        {/* Header */}
        <Box>
          <Text size="xl" fw={700} c="grey.9">Scenario Catalog</Text>
          <Text size="xs" c="dimmed" mt={2}>
            {SCENARIO_PRESETS.length} benchmark scenarios across 3 phases — click any scenario to see full details
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
