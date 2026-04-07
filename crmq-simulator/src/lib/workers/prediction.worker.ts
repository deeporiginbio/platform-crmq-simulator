/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Prediction Web Worker
 * ======================
 * Runs the Virtual Cluster predict() function off the main thread
 * so the UI stays responsive during heavy prediction loops.
 *
 * Protocol:
 *   Main → Worker:  { type: 'predict', id, queue, active,
 *                      orgUsage, currentTime, config, orgs }
 *   Worker → Main:  { type: 'result', id, predictions }
 */

import type {
  Job,
  RunningJob,
  OrgUsageMap,
  Org,
  PredictionMap,
} from '../types';
import { predict } from '../virtual-cluster';
import {
  hydrateConfig,
  type SerializableConfig,
} from './config-serde';

// ── Message Types ───────────────────────────────────────────────────

export interface PredictRequest {
  type: 'predict';
  id: number;
  queue: Job[];
  active: RunningJob[];
  orgUsage: OrgUsageMap;
  currentTime: number;
  config: SerializableConfig;
  orgs: Org[];
}

export interface PredictResponse {
  type: 'result';
  id: number;
  predictions: PredictionMap;
}

// ── Worker Entry Point ──────────────────────────────────────────────

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<PredictRequest>) => {
  const msg = e.data;
  if (msg.type !== 'predict') return;

  const config = hydrateConfig(msg.config);

  // Scale down iterations for large queues to
  // keep prediction time reasonable.
  const qLen = msg.queue.length;
  let maxIter = 500;
  if (qLen > 500) maxIter = 50;
  else if (qLen > 200) maxIter = 150;
  else if (qLen > 100) maxIter = 300;

  const predictions = predict(
    msg.queue,
    msg.active,
    msg.orgUsage,
    msg.currentTime,
    config,
    msg.orgs,
    maxIter,
  );

  const response: PredictResponse = {
    type: 'result',
    id: msg.id,
    predictions,
  };
  ctx.postMessage(response);
};
