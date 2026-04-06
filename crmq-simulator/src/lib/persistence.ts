/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * Persistence Layer
 * ==================
 * localStorage-backed CRUD for configs, benchmarks, and reports.
 * Also provides JSON export/import for portability.
 *
 * Design decisions:
 * - ResourcePool.routeWhen is a function and can't be serialized.
 *   We store a pool "recipe" (type + totals + reserved) and reconstruct
 *   the routeWhen from DEFAULT_CONFIG's pool definitions at load time.
 * - All saved items have an `id`, `name`, `createdAt`, `updatedAt`.
 * - localStorage keys are prefixed with `crmq:` to avoid collisions.
 */

import type { CRMQConfig, Org, Resources } from './types';
import type { BenchmarkRun, BenchmarkReport } from './config/types';
import { DEFAULT_CONFIG } from './scheduler';

// ── Storage Keys ────────────────────────────────────────────────────────────

const KEYS = {
  configs: 'crmq:configs',
  benchmarks: 'crmq:benchmarks',
  reports: 'crmq:reports',
} as const;

// ── Serializable Types ──────────────────────────────────────────────────────

/**
 * A serializable snapshot of a pool — no functions.
 * The routeWhen predicate is reconstructed at load time.
 */
interface SerializablePool {
  type: string;
  label: string;
  shortLabel: string;
  color: string;
  quotaType: 'cpu' | 'gpu';
  total: Resources;
  reserved: Resources;
}

/** Serializable version of CRMQConfig (pools stripped of routeWhen) */
interface SerializableConfig {
  scoring: CRMQConfig['scoring'];
  scheduler: CRMQConfig['scheduler'];
  cluster: { pools: SerializablePool[] };
  ttlDefault: number;
  formulaType?: CRMQConfig['formulaType'];
  formulaParams?: CRMQConfig['formulaParams'];
}

// ── Saved Item Wrappers ─────────────────────────────────────────────────────

export interface SavedConfig {
  id: string;
  name: string;
  description?: string;
  createdAt: number;  // epoch ms
  updatedAt: number;
  config: SerializableConfig;
  orgs: Org[];
}

export interface SavedBenchmark {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  run: BenchmarkRun;
}

export interface SavedReport {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  report: BenchmarkReport;
}

// ── Export/Import Envelope ───────────────────────────────────────────────────

export interface CRMQExport {
  version: 1;
  exportedAt: number;
  type: 'config' | 'benchmark' | 'report' | 'full';
  configs?: SavedConfig[];
  benchmarks?: SavedBenchmark[];
  reports?: SavedReport[];
}

// ── ID Generation ───────────────────────────────────────────────────────────

let _counter = 0;
export const genId = () => `${Date.now()}-${++_counter}`;

// ── Serialization Helpers ───────────────────────────────────────────────────

/**
 * Strip routeWhen from pools for JSON serialization.
 */
const stripConfig = (cfg: CRMQConfig): SerializableConfig => ({
  scoring: { ...cfg.scoring },
  scheduler: { ...cfg.scheduler },
  cluster: {
    pools: cfg.cluster.pools.map(({ routeWhen: _, ...rest }) => rest),
  },
  ttlDefault: isFinite(cfg.ttlDefault) ? cfg.ttlDefault : -1,  // -1 sentinel → Infinity
  formulaType: cfg.formulaType,
  formulaParams: cfg.formulaParams ? { ...cfg.formulaParams } : undefined,
});

/**
 * Reconstruct live CRMQConfig from a serialized snapshot.
 * Restores routeWhen by matching pool types against DEFAULT_CONFIG,
 * or falls back to a GPU-based heuristic.
 */
export const hydrateConfig = (raw: SerializableConfig): CRMQConfig => ({
  scoring: { ...raw.scoring },
  scheduler: { ...raw.scheduler },
  cluster: {
    pools: raw.cluster.pools.map((sp) => {
      // Try to find the matching default pool for its routeWhen
      const defaultPool = DEFAULT_CONFIG.cluster.pools.find(p => p.type === sp.type);
      const routeWhen = defaultPool?.routeWhen ?? ((job: { resources: Resources }) =>
        sp.quotaType === 'gpu' ? job.resources.gpu > 0 : job.resources.gpu === 0
      );
      return { ...sp, routeWhen };
    }),
  },
  ttlDefault: (raw.ttlDefault == null || raw.ttlDefault <= 0) ? Infinity : raw.ttlDefault,
  formulaType: raw.formulaType,
  formulaParams: raw.formulaParams,
});

// ── Generic localStorage CRUD ───────────────────────────────────────────────

const readList = <T>(key: string): T[] => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const writeList = <T>(key: string, items: T[]) => {
  localStorage.setItem(key, JSON.stringify(items));
};

// ── Config CRUD ─────────────────────────────────────────────────────────────

export const listConfigs = (): SavedConfig[] => readList<SavedConfig>(KEYS.configs);

export const getConfig = (id: string): SavedConfig | undefined =>
  listConfigs().find(c => c.id === id);

export const saveConfig = (
  name: string,
  cfg: CRMQConfig,
  orgs: Org[],
  description?: string,
  existingId?: string,
): SavedConfig => {
  const list = listConfigs();
  const now = Date.now();

  if (existingId) {
    const idx = list.findIndex(c => c.id === existingId);
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        name,
        description,
        updatedAt: now,
        config: stripConfig(cfg),
        orgs: structuredClone(orgs),
      };
      writeList(KEYS.configs, list);
      return list[idx];
    }
  }

  const saved: SavedConfig = {
    id: genId(),
    name,
    description,
    createdAt: now,
    updatedAt: now,
    config: stripConfig(cfg),
    orgs: structuredClone(orgs),
  };
  list.unshift(saved);
  writeList(KEYS.configs, list);
  return saved;
};

export const deleteConfig = (id: string) => {
  writeList(KEYS.configs, listConfigs().filter(c => c.id !== id));
};

// ── Benchmark CRUD ──────────────────────────────────────────────────────────

export const listBenchmarks = (): SavedBenchmark[] => readList<SavedBenchmark>(KEYS.benchmarks);

export const getBenchmark = (id: string): SavedBenchmark | undefined =>
  listBenchmarks().find(b => b.id === id);

export const saveBenchmark = (name: string, run: BenchmarkRun, existingId?: string): SavedBenchmark => {
  const list = listBenchmarks();
  const now = Date.now();

  if (existingId) {
    const idx = list.findIndex(b => b.id === existingId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], name, updatedAt: now, run };
      writeList(KEYS.benchmarks, list);
      return list[idx];
    }
  }

  const saved: SavedBenchmark = { id: genId(), name, createdAt: now, updatedAt: now, run };
  list.unshift(saved);
  writeList(KEYS.benchmarks, list);
  return saved;
};

export const deleteBenchmark = (id: string) => {
  writeList(KEYS.benchmarks, listBenchmarks().filter(b => b.id !== id));
};

// ── Report CRUD ─────────────────────────────────────────────────────────────

export const listReports = (): SavedReport[] => readList<SavedReport>(KEYS.reports);

export const getReport = (id: string): SavedReport | undefined =>
  listReports().find(r => r.id === id);

export const saveReport = (name: string, report: BenchmarkReport, existingId?: string): SavedReport => {
  const list = listReports();
  const now = Date.now();

  if (existingId) {
    const idx = list.findIndex(r => r.id === existingId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], name, updatedAt: now, report };
      writeList(KEYS.reports, list);
      return list[idx];
    }
  }

  const saved: SavedReport = { id: genId(), name, createdAt: now, updatedAt: now, report };
  list.unshift(saved);
  writeList(KEYS.reports, list);
  return saved;
};

export const deleteReport = (id: string) => {
  writeList(KEYS.reports, listReports().filter(r => r.id !== id));
};

// ── JSON Export / Import ────────────────────────────────────────────────────

export const exportToJson = (
  type: CRMQExport['type'],
  data: {
    configs?: SavedConfig[];
    benchmarks?: SavedBenchmark[];
    reports?: SavedReport[];
  },
): string => {
  const envelope: CRMQExport = {
    version: 1,
    exportedAt: Date.now(),
    type,
    ...data,
  };
  return JSON.stringify(envelope, null, 2);
};

export const importFromJson = (json: string): CRMQExport => {
  const parsed = JSON.parse(json);
  if (parsed.version !== 1) {
    throw new Error(`Unsupported export version: ${parsed.version}`);
  }
  return parsed as CRMQExport;
};

/**
 * Merge imported data into localStorage.
 * Skips items with duplicate IDs (existing data wins).
 * Returns counts of imported items.
 */
export const mergeImport = (data: CRMQExport): { configs: number; benchmarks: number; reports: number } => {
  let configCount = 0;
  let benchmarkCount = 0;
  let reportCount = 0;

  if (data.configs?.length) {
    const existing = listConfigs();
    const existingIds = new Set(existing.map(c => c.id));
    const newItems = data.configs.filter(c => !existingIds.has(c.id));
    writeList(KEYS.configs, [...newItems, ...existing]);
    configCount = newItems.length;
  }

  if (data.benchmarks?.length) {
    const existing = listBenchmarks();
    const existingIds = new Set(existing.map(b => b.id));
    const newItems = data.benchmarks.filter(b => !existingIds.has(b.id));
    writeList(KEYS.benchmarks, [...newItems, ...existing]);
    benchmarkCount = newItems.length;
  }

  if (data.reports?.length) {
    const existing = listReports();
    const existingIds = new Set(existing.map(r => r.id));
    const newItems = data.reports.filter(r => !existingIds.has(r.id));
    writeList(KEYS.reports, [...newItems, ...existing]);
    reportCount = newItems.length;
  }

  return { configs: configCount, benchmarks: benchmarkCount, reports: reportCount };
};

/**
 * Export everything in localStorage as a single JSON blob.
 */
export const exportAll = (): string =>
  exportToJson('full', {
    configs: listConfigs(),
    benchmarks: listBenchmarks(),
    reports: listReports(),
  });

/**
 * Trigger a browser file download for a JSON string.
 */
export const downloadJson = (json: string, filename: string) => {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Read a File object as text (for file input import).
 */
export const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
