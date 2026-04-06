/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Virtual Cluster — Time-to-Start Estimation Engine
 * =======================================================
 * Implements §2.3 of the CRMQ design doc.
 *
 * Creates an in-memory snapshot, fast-forwards time event-by-event,
 * and predicts when each queued job will start.
 *
 * Dependencies: scheduler.ts (same package)
 */

import {
  type Resources,
  type Org,
  type Job,
  type RunningJob,
  type CRMQConfig,
  type OrgUsageMap,
  type Prediction,
  type PredictionMap,
  type PredictionStatus,
  type FormattedPrediction,
  type ReasonLabel,
  BlockingReason,
} from './types';

import {
  calcScore,
  getAvailability,
  getAvailabilityPerPool,
  fits,
  sub3,
  sumResources,
  runScheduler,
  completeJobs,
  evictExpired,
  shallowCloneOrgUsage,
  fmtTime,
  ZERO,
} from './scheduler';
import { getJobPoolType } from './types';


// ── Deep Clone Helpers ───────────────────────────────────────────────────────

const deepCloneJob = <T extends Job>(j: T): T => {
  return {
    ...j,
    resources: { ...j.resources },
  };
};

const deepCloneArray = <T extends Job>(arr: T[]): T[] => {
  return arr.map(deepCloneJob);
};


// ── Determine Blocking Reason (§1.5 Contextual Status) ──────────────────────

export const determineBlockingReason = (
  job: Job,
  availByPool: Record<string, Resources>,
  orgUsage: OrgUsageMap,
  orgs: Org[],
  config: CRMQConfig,
  reservMode: boolean,
  reservTarget: string | null,
  queueRank: number,
): BlockingReason => {
  const org = orgs.find(o => o.id === job.orgId);
  const poolType = getJobPoolType(job, config);
  const orgPoolLimits = org?.limits[poolType] ?? { cpu: 9999, memory: 9999, gpu: 9999 };
  const orgPools = orgUsage[job.orgId];
  const orgUsedInPool = orgPools?.[poolType] ?? { cpu: 0, memory: 0, gpu: 0 };

  // Org quota (per-pool)
  const orgOk = (
    orgUsedInPool.cpu    + job.resources.cpu    <= orgPoolLimits.cpu    &&
    orgUsedInPool.memory + job.resources.memory <= orgPoolLimits.memory &&
    orgUsedInPool.gpu    + job.resources.gpu    <= orgPoolLimits.gpu
  );
  if (!orgOk) return BlockingReason.BLOCKED_BY_ORG_QUOTA;

  // Reservation mode
  if (reservMode && reservTarget && job.id !== reservTarget) {
    return BlockingReason.BLOCKED_BY_RESERVATION_MODE;
  }

  // Capacity — check pool (poolType already computed above)
  const avail = availByPool[poolType] ?? { cpu: 0, memory: 0, gpu: 0 };

  // Capacity — identify bottleneck dimension
  const cpuShort = job.resources.cpu    > avail.cpu;
  const memShort = job.resources.memory > avail.memory;
  const gpuShort = job.resources.gpu    > avail.gpu;
  const shortCount = (cpuShort ? 1 : 0) + (memShort ? 1 : 0) + (gpuShort ? 1 : 0);

  if (shortCount > 1) return BlockingReason.WAITING_FOR_MULTI_RESOURCE;
  if (gpuShort)        return BlockingReason.WAITING_FOR_GPU_CAPACITY;
  if (cpuShort)        return BlockingReason.WAITING_FOR_CPU_CAPACITY;
  if (memShort)        return BlockingReason.WAITING_FOR_MEMORY_CAPACITY;

  if (queueRank > 0)  return BlockingReason.QUEUED_BEHIND_HIGHER_PRIORITY;

  return BlockingReason.UNKNOWN;
};


// ── Confidence Variance (§1.5) ───────────────────────────────────────────────

export const calcVariance = (
  prediction: Prediction,
  queueDepth: number,
  activeCount: number,
): number => {
  const baseVariance = 5;
  const depthFactor  = Math.min(30, prediction.queueRank * 2);
  const timeFactor   = Math.min(25, Math.floor((prediction.delta ?? 0) / 60));
  const activeFactor = Math.min(15, activeCount * 1.5);

  return Math.min(50, Math.round(baseVariance + depthFactor + timeFactor + activeFactor));
};


// ── Core: Predict Time-to-Start (§2.3) ──────────────────────────────────────

export const predict = (
  currentQueue: Job[],
  currentActive: RunningJob[],
  currentOrgUsage: OrgUsageMap,
  currentTime: number,
  config: CRMQConfig,
  orgs: Org[],
): PredictionMap => {
  // 1. Deep clone — this IS the "Virtual Cluster"
  let simQueue    = deepCloneArray(currentQueue);
  let simActive   = deepCloneArray(currentActive) as RunningJob[];
  let simOrgUsage = shallowCloneOrgUsage(currentOrgUsage);
  let simTime     = currentTime;
  let simReservMode   = false;
  let simReservTarget: string | null = null;

  const predictions: PredictionMap = {};

  // Initialize predictions (pessimistic defaults)
  const rankedInit = simQueue
    .map(j => ({ id: j.id, score: calcScore(j, simTime, config, orgs) }))
    .sort((a, b) => b.score - a.score);

  for (let ri = 0; ri < rankedInit.length; ri++) {
    const ji = simQueue.find(j => j.id === rankedInit[ri].id)!;
    const initAvailByPool = getAvailabilityPerPool(config, simActive);
    predictions[ji.id] = {
      delta:              null,
      estimatedStartTime: null,
      blockingReason:     determineBlockingReason(ji, initAvailByPool, simOrgUsage, orgs, config, simReservMode, simReservTarget, ri),
      variance:           null,
      queueRank:          ri,
      status:             'WAITING',
    };
  }

  // 2. Event-driven fast-forward loop
  const MAX_ITERATIONS = 500;
  let iteration = 0;

  while (simQueue.length > 0 && iteration < MAX_ITERATIONS) {
    iteration++;

    // Try dispatching with current resources
    const beforeCount = simQueue.length;
    const result = runScheduler(
      simQueue, simActive, simOrgUsage,
      simReservMode, simReservTarget,
      simTime, config, orgs,
      undefined, // silent — no logging in virtual cluster
    );

    simQueue        = result.queue as Job[];
    simActive       = result.active;
    simOrgUsage     = result.orgUsage;
    simReservMode   = result.reservMode;
    simReservTarget = result.reservTarget;

    // Record predictions for newly dispatched jobs
    const afterCount = simQueue.length;
    if (afterCount < beforeCount) {
      const queueIds = new Set(simQueue.map(j => j.id));
      for (const aj of simActive) {
        if (predictions[aj.id] && predictions[aj.id].status === 'WAITING') {
          predictions[aj.id] = {
            ...predictions[aj.id],
            delta:              Math.max(0, simTime - currentTime),
            estimatedStartTime: simTime,
            blockingReason:     BlockingReason.NONE,
            status:             'PREDICTED',
          };
        }
      }
      continue; // try dispatching more in same tick
    }

    // No more dispatches — find next completion event
    if (simActive.length === 0) break;

    let nextCompletionTime = Infinity;
    for (const j of simActive) {
      const finishTime = j.startedAt + j.estimatedDuration;
      if (finishTime < nextCompletionTime) nextCompletionTime = finishTime;
    }

    if (nextCompletionTime === Infinity || nextCompletionTime <= simTime) break;

    // Jump time
    const dt = nextCompletionTime - simTime;
    simTime = nextCompletionTime;

    // Complete finished jobs
    const comp = completeJobs(simActive, dt, simTime, simOrgUsage, config);
    simActive   = comp.stillRunning;
    simOrgUsage = comp.orgUsage;

    // TTL eviction
    const ttl = evictExpired(simQueue, simTime);
    simQueue = ttl.live;

    for (const ej of ttl.evicted) {
      if (predictions[ej.id]) {
        predictions[ej.id] = {
          ...predictions[ej.id],
          status:         'WILL_EXPIRE',
          blockingReason: BlockingReason.WILL_EXCEED_TTL,
          delta:          ej.ttl,
        };
      }
    }

    // Update blocking reasons for remaining queued jobs
    const rankedNow = simQueue
      .map(j => ({ id: j.id, score: calcScore(j, simTime, config, orgs) }))
      .sort((a, b) => b.score - a.score);

    const simAvailByPool = getAvailabilityPerPool(config, simActive);

    for (let ui = 0; ui < rankedNow.length; ui++) {
      const uj = simQueue.find(j => j.id === rankedNow[ui].id)!;
      if (predictions[uj.id]?.status === 'WAITING') {
        predictions[uj.id] = {
          ...predictions[uj.id],
          blockingReason: determineBlockingReason(uj, simAvailByPool, simOrgUsage, orgs, config, simReservMode, simReservTarget, ui),
          queueRank: ui,
        };
      }
    }
  }

  // 3. Compute variance
  const activeCount = currentActive.length;
  for (const pid of Object.keys(predictions)) {
    const pred = predictions[pid];
    if (pred.status === 'PREDICTED' && pred.delta !== null) {
      predictions[pid] = {
        ...pred,
        variance: calcVariance(pred, currentQueue.length, activeCount),
      };
    } else if (pred.status === 'WAITING') {
      predictions[pid] = {
        ...pred,
        status:   'UNPREDICTABLE',
        variance: 50,
      };
    }
  }

  return predictions;
};


// ── Display Helpers ──────────────────────────────────────────────────────────

export const formatPrediction = (pred: Prediction): FormattedPrediction => {
  switch (pred.status) {
    case 'PREDICTED': {
      const low  = Math.max(0, Math.round((pred.delta ?? 0) * (1 - (pred.variance ?? 0) / 100)));
      const high = Math.round((pred.delta ?? 0) * (1 + (pred.variance ?? 0) / 100));
      return {
        label:  fmtTime(pred.delta ?? 0),
        window: `${fmtTime(low)} – ${fmtTime(high)}`,
        detail: `±${pred.variance}%`,
        css:    (pred.delta ?? 0) < 60 ? '#11A468' : (pred.delta ?? 0) < 300 ? '#4A65DC' : '#B27700',
      };
    }
    case 'WILL_EXPIRE':
      return {
        label:  'Will expire',
        window: 'TTL exceeded before resources available',
        detail: `TTL: ${fmtTime(pred.delta ?? 0)}`,
        css:    '#D93E39',
      };
    case 'UNPREDICTABLE':
      return {
        label:  'Unknown',
        window: 'Cannot estimate — no capacity event in horizon',
        detail: pred.blockingReason,
        css:    '#6B7280',
      };
    default:
      return { label: '—', detail: '', css: '#6B7280' };
  }
};


export const REASON_LABELS: Record<BlockingReason, ReasonLabel> = {
  [BlockingReason.NONE]:                          { label: 'Ready',               icon: '✅', css: '#11A468'  },
  [BlockingReason.WAITING_FOR_CPU_CAPACITY]:      { label: 'Waiting for CPU',     icon: '🖥',  css: '#4A65DC'   },
  [BlockingReason.WAITING_FOR_MEMORY_CAPACITY]:   { label: 'Waiting for Memory',  icon: '💾', css: '#7638E5' },
  [BlockingReason.WAITING_FOR_GPU_CAPACITY]:      { label: 'Waiting for GPU',     icon: '🎮', css: '#B27700'  },
  [BlockingReason.WAITING_FOR_MULTI_RESOURCE]:    { label: 'Multi-resource wait', icon: '📦', css: '#B27700' },
  [BlockingReason.BLOCKED_BY_ORG_QUOTA]:          { label: 'Org quota limit',     icon: '🏢', css: '#D93E39'    },
  [BlockingReason.QUEUED_BEHIND_HIGHER_PRIORITY]: { label: 'Behind higher-P',     icon: '⬆',  css: '#0891B2'   },
  [BlockingReason.BLOCKED_BY_RESERVATION_MODE]:   { label: 'Reservation block',   icon: '🔒', css: '#7638E5' },
  [BlockingReason.WILL_EXCEED_TTL]:               { label: 'Will exceed TTL',     icon: '⏰', css: '#D93E39'    },
  [BlockingReason.UNKNOWN]:                       { label: 'Unknown',             icon: '❓', css: '#6B7280'  },
};

export const getReasonLabel = (reason: BlockingReason): ReasonLabel => {
  return REASON_LABELS[reason] ?? REASON_LABELS[BlockingReason.UNKNOWN];
};
