/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

/**
 * CRMQ Benchmark — Consolidated Report Export
 * ==============================================
 * Generates a single comprehensive report from
 * multi-scenario benchmark results.
 *
 * Formats:
 *   - PDF   (jsPDF with Plotly chart images)
 *   - Markdown (tables + cross-scenario summary)
 *   - JSON  (consolidated data)
 *   - CSV   (consolidated flat table)
 */

import type {
  BenchmarkSuiteResult,
  ScenarioResult,
} from './runner';
import type {
  AggregatedMetrics,
  ConfidenceInterval,
} from './statistics';
import type {
  ScenarioPreset,
  ArrivalPattern,
  JobSizeDistribution,
} from './traffic';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '../units';
import type { jsPDF } from 'jspdf';
import type { CellHookData, UserOptions } from 'jspdf-autotable';

// jspdf-autotable patches jsPDF at runtime; the types don't include these members.
type JsPDFWithAutoTable = jsPDF & {
  autoTable: (options: UserOptions) => void;
  lastAutoTable: { finalY: number };
};

// Plotly's Data/Layout types are tagged unions with string-literal discriminators.
// Our plain object-literal traces widen `type: 'bar'` to `string`; we assert on return.
type ChartBundle = {
  traces: Plotly.Data[];
  layout: Partial<Plotly.Layout>;
};

// Re-use the store type locally
interface MultiScenarioEntry {
  preset: ScenarioPreset;
  result: BenchmarkSuiteResult;
}

// ── Formatting helpers ─────────────────────────

const fmtSec = (sec: number): string => {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
};

const fmtPct = (n: number): string =>
  Number.isFinite(n)
    ? `${(n * 100).toFixed(1)}%`
    : '—';

const fmtNum = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toFixed(d) : '—';

const ciStr = (ci: ConfidenceInterval): string =>
  `${fmtNum(ci.mean)} [${fmtNum(ci.low)} – ${fmtNum(ci.high)}]`;

const ciTimeStr = (ci: ConfidenceInterval): string =>
  `${fmtSec(ci.mean)} [${fmtSec(ci.low)} – ${fmtSec(ci.high)}]`;

const ciPctStr = (ci: ConfidenceInterval): string =>
  `${fmtPct(ci.mean)} [${fmtPct(ci.low)} – ${fmtPct(ci.high)}]`;

const timestamp = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}_` +
    `${pad(d.getHours())}` +
    `${pad(d.getMinutes())}`
  );
};

const download = (
  content: string,
  filename: string,
  mime: string,
): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ── Arrival / Size description ─────────────────

const describeArrival = (p: ArrivalPattern): string => {
  switch (p.type) {
    case 'poisson':
      return `Poisson — ${p.lambdaPerMinute} jobs/min`;
    case 'uniform':
      return `Uniform — ${p.ratePerMinute} jobs/min`;
    case 'burst':
      return `Burst — ${p.count} jobs at t=${p.atTime}s`;
    case 'mmpp':
      return (
        `MMPP — ` +
        p.states
          .map(
            (s) =>
              `${s.label}: ` +
              `${s.lambdaPerMinute}/min ` +
              `(${(s.weight * 100).toFixed(0)}%)`,
          )
          .join(', ')
      );
    case 'periodic_mix':
      return (
        `Periodic Mix — ` +
        `${p.templates.length} templates`
      );
  }
};

const describeSize = (
  d: JobSizeDistribution,
): string => {
  switch (d.type) {
    case 'fixed':
      return (
        `Fixed — ${d.cpu} CPU, ` +
        `${d.memory} GB, ${d.gpu} GPU, ` +
        `${fmtSec(d.duration)}`
      );
    case 'uniform':
      return (
        `Uniform — ` +
        `CPU ${d.cpuRange[0]}–${d.cpuRange[1]}, ` +
        `Mem ${d.memoryRange[0]}–` +
        `${d.memoryRange[1]} GB` +
        (d.gpuRange[1] > 0
          ? `, GPU ${d.gpuRange[0]}–${d.gpuRange[1]}`
          : '') +
        `, Duration ${fmtSec(d.durationRange[0])}` +
        `–${fmtSec(d.durationRange[1])}`
      );
    case 'pareto':
      return (
        `Pareto (α=${d.alpha}) — ` +
        `min CPU ${d.cpuMin}, ` +
        `min Mem ${d.memoryMin} GB, ` +
        `min Duration ${fmtSec(d.durationMin)}`
      );
    case 'mixed':
      return (
        `Mixed — ${d.small}% small, ` +
        `${d.medium}% medium, ` +
        `${d.large}% large`
      );
  }
};

// ── Cross-scenario win tally computation ───────

type MetricKey =
  | 'throughput'
  | 'meanWaitTime'
  | 'p95WaitTime'
  | 'jainsIndex';

interface MetricDef {
  key: MetricKey;
  label: string;
  direction: 'higher-better' | 'lower-better';
  extract: (a: AggregatedMetrics) => number;
}

const METRICS: MetricDef[] = [
  {
    key: 'throughput',
    label: 'Throughput (jobs/min)',
    direction: 'higher-better',
    extract: (a) => a.throughput.mean,
  },
  {
    key: 'meanWaitTime',
    label: 'Mean Wait Time',
    direction: 'lower-better',
    extract: (a) => a.meanWaitTime.mean,
  },
  {
    key: 'p95WaitTime',
    label: 'P95 Wait Time',
    direction: 'lower-better',
    extract: (a) => a.p95WaitTime.mean,
  },
  {
    key: 'jainsIndex',
    label: "Jain's Fairness Index",
    direction: 'higher-better',
    extract: (a) => a.jainsIndex.mean,
  },
];

interface WinTally {
  formulaNames: string[];
  /** metric → formula → win count */
  winTally: Record<string, Record<string, number>>;
  /** formula → total win count */
  overallWins: Record<string, number>;
  /** scenarioId → metric → winner names */
  scenarioWinners: Record<
    string,
    Record<string, string[]>
  >;
  bestFormulas: string[];
  totalContests: number;
}

const computeWinTally = (
  entries: MultiScenarioEntry[],
): WinTally => {
  const formulaNames =
    entries[0]?.result.scenarios.map(
      (s) => s.scenarioName,
    ) ?? [];

  const winTally: Record<
    string,
    Record<string, number>
  > = {};
  for (const m of METRICS) {
    winTally[m.key] = {};
    for (const fn of formulaNames) {
      winTally[m.key][fn] = 0;
    }
  }

  const overallWins: Record<string, number> = {};
  for (const fn of formulaNames) {
    overallWins[fn] = 0;
  }

  const scenarioWinners: Record<
    string,
    Record<string, string[]>
  > = {};

  for (const entry of entries) {
    scenarioWinners[entry.preset.id] = {};
    for (const m of METRICS) {
      const vals = entry.result.scenarios.map((s) =>
        m.extract(s.aggregated),
      );
      let bestVal = vals[0];
      for (let i = 1; i < vals.length; i++) {
        if (m.direction === 'higher-better') {
          if (vals[i] > bestVal) bestVal = vals[i];
        } else {
          if (vals[i] < bestVal) bestVal = vals[i];
        }
      }
      const winners: string[] = [];
      for (let i = 0; i < vals.length; i++) {
        const rel =
          Math.abs(bestVal) > 1e-9
            ? Math.abs(vals[i] - bestVal) /
              Math.abs(bestVal)
            : Math.abs(vals[i] - bestVal);
        if (rel < 0.001) {
          winners.push(formulaNames[i]);
        }
      }
      scenarioWinners[entry.preset.id][m.key] =
        winners;
      for (const w of winners) {
        winTally[m.key][w] =
          (winTally[m.key][w] ?? 0) + 1;
        overallWins[w] =
          (overallWins[w] ?? 0) + 1;
      }
    }
  }

  const sorted = [...formulaNames].sort(
    (a, b) =>
      (overallWins[b] ?? 0) -
      (overallWins[a] ?? 0),
  );
  const bestWins = overallWins[sorted[0]] ?? 0;
  const bestFormulas = sorted.filter(
    (fn) => (overallWins[fn] ?? 0) === bestWins,
  );
  const totalContests =
    entries.length * METRICS.length;

  return {
    formulaNames,
    winTally,
    overallWins,
    scenarioWinners,
    bestFormulas,
    totalContests,
  };
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF Report (jsPDF + Plotly chart images)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const FORMULA_COLORS = [
  '#4A65DC', '#11A468', '#E8590C', '#9C36B5',
  '#2B8A3E', '#D6336C', '#1098AD', '#F59F00',
  '#495057', '#862E9C',
];

const FORMULA_COLORS_LIGHT = FORMULA_COLORS.map(
  (c) => c + '40',
);

// ── Academic table styling helper ───────────
const academicTableStyle = {
  theme: 'plain' as const,
  styles: {
    fontSize: 7.5,
    cellPadding: 2.5,
    lineColor: [0, 0, 0] as [number, number, number],
    lineWidth: 0,
  },
  headStyles: {
    fillColor: [255, 255, 255] as [number, number, number],
    textColor: [30, 30, 30] as [number, number, number],
    fontStyle: 'bold' as const,
    lineWidth: 0,
  },
  didDrawCell: (data: CellHookData) => {
    const doc = data.doc;
    if (data.section === 'head') {
      // 2px top border on header
      if (data.row.index === 0) {
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.6);
        doc.line(
          data.cell.x,
          data.cell.y,
          data.cell.x + data.cell.width,
          data.cell.y,
        );
      }
      // 2px bottom border on header
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.6);
      doc.line(
        data.cell.x,
        data.cell.y + data.cell.height,
        data.cell.x + data.cell.width,
        data.cell.y + data.cell.height,
      );
    } else if (data.section === 'body') {
      const isLastRow =
        data.row.index ===
        data.table.body.length - 1;
      doc.setDrawColor(
        isLastRow ? 0 : 200,
        isLastRow ? 0 : 200,
        isLastRow ? 0 : 200,
      );
      doc.setLineWidth(isLastRow ? 0.6 : 0.15);
      doc.line(
        data.cell.x,
        data.cell.y + data.cell.height,
        data.cell.x + data.cell.width,
        data.cell.y + data.cell.height,
      );
    }
  },
};

/**
 * Render a Plotly chart off-screen and return a
 * base-64 PNG data URL.
 */
async function renderChartImage(
  traces: Plotly.Data[],
  layout: Partial<Plotly.Layout>,
  width = 520,
  height = 300,
): Promise<string> {
  const Plotly = await import('plotly.js-dist-min');
  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.left = '-9999px';
  document.body.appendChild(div);
  try {
    await Plotly.default.newPlot(
      div,
      traces as Plotly.Data[],
      {
        ...layout,
        width,
        height,
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#fafbfc',
      },
      { displayModeBar: false, staticPlot: true },
    );
    const png = await Plotly.default.toImage(div, {
      format: 'png',
      width,
      height,
      scale: 2,
    });
    return png; // data:image/png;base64,...
  } finally {
    Plotly.default.purge(div);
    document.body.removeChild(div);
  }
}

// ── Plotly trace builders (shared) ────────────

function buildRadarTraces(
  scenarios: ScenarioResult[],
): { traces: Plotly.Data[]; layout: Partial<Plotly.Layout> } {
  const axisLabels = [
    'Throughput', 'Fairness', 'Mean Wait',
    'Tail Wait (P95)', 'CPU Util',
  ];
  const raw = scenarios.map((s) => ({
    throughput: s.aggregated.throughput.mean,
    fairness: s.aggregated.jainsIndex.mean,
    meanWait: s.aggregated.meanWaitTime.mean,
    tailWait: s.aggregated.p95WaitTime.mean,
    utilCpu: (() => {
      const pools = Object.values(
        s.aggregated.utilization,
      );
      if (!pools.length) return 0;
      return (
        pools.reduce(
          (sum, p) => sum + p.cpu.mean, 0,
        ) / pools.length
      );
    })(),
  }));
  const keys = [
    'throughput', 'fairness', 'meanWait',
    'tailWait', 'utilCpu',
  ] as const;
  const mins: Record<string, number> = {};
  const maxs: Record<string, number> = {};
  for (const k of keys) {
    const vals = raw.map(
      (r) => r[k as keyof (typeof raw)[0]],
    );
    mins[k] = Math.min(...vals);
    maxs[k] = Math.max(...vals);
  }
  const norm = (
    val: number, key: string, invert: boolean,
  ): number => {
    const range = maxs[key] - mins[key];
    if (range === 0) return 100;
    const n = (val - mins[key]) / range;
    const scaled = 1 + n * 99;
    return invert ? 101 - scaled : scaled;
  };
  const traces = scenarios.map((s, i) => {
    const r = raw[i];
    const values = [
      norm(r.throughput, 'throughput', false),
      norm(r.fairness, 'fairness', false),
      norm(r.meanWait, 'meanWait', true),
      norm(r.tailWait, 'tailWait', true),
      norm(r.utilCpu, 'utilCpu', false),
    ];
    values.push(values[0]);
    const labels = [...axisLabels, axisLabels[0]];
    return {
      type: 'scatterpolar',
      name: s.scenarioName,
      r: values,
      theta: labels,
      fill: 'toself',
      fillcolor: FORMULA_COLORS_LIGHT[
        i % FORMULA_COLORS.length
      ],
      line: {
        color: FORMULA_COLORS[
          i % FORMULA_COLORS.length
        ],
        width: 2,
      },
      marker: { size: 5 },
      text: values.map((v) =>
        v.toFixed(0),
      ),
      textposition: 'top center',
      textfont: { size: 10 },
      mode: 'lines+markers+text',
    };
  });
  const layout = {
    font: {
      family: 'Helvetica, Arial, sans-serif',
      size: 11,
    },
    margin: { t: 28, r: 70, b: 28, l: 70 },
    polar: {
      radialaxis: {
        visible: true, range: [0, 105],
        tickvals: [0, 25, 50, 75, 100],
        gridcolor: '#e8e8e8',
      },
      angularaxis: {
        gridcolor: '#e8e8e8',
        linecolor: '#ccc',
      },
    },
    legend: {
      orientation: 'h', y: -0.15, x: 0.5,
      xanchor: 'center', font: { size: 9 },
    },
    showlegend: true,
  };
  return { traces, layout } as ChartBundle;
}

function buildBarTraces(
  scenarios: ScenarioResult[],
  getter: string,
  yTitle: string,
): { traces: Plotly.Data[]; layout: Partial<Plotly.Layout> } {
  const traces = scenarios.map((s, i) => {
    const ci = s.aggregated[
      getter as keyof AggregatedMetrics
    ] as ConfidenceInterval;
    return {
      type: 'bar', name: s.scenarioName,
      x: [s.scenarioName], y: [ci.mean],
      text: [ci.mean.toFixed(3)],
      textposition: 'outside',
      textfont: { size: 11 },
      error_y: {
        type: 'data', symmetric: false,
        array: [ci.high - ci.mean],
        arrayminus: [ci.mean - ci.low],
        color: '#555', thickness: 1.5, width: 4,
      },
      marker: {
        color: FORMULA_COLORS[
          i % FORMULA_COLORS.length
        ],
      },
    };
  });
  return {
    traces,
    layout: {
      font: {
        family: 'Helvetica, Arial, sans-serif',
        size: 11,
      },
      margin: { t: 24, r: 16, b: 44, l: 60 },
      showlegend: false, bargap: 0.25,
      yaxis: {
        title: { text: yTitle, standoff: 8 },
        rangemode: 'tozero',
        gridcolor: '#f0f0f0',
      },
      xaxis: { tickfont: { size: 10 } },
    },
  } as ChartBundle;
}

function buildGroupedWaitTraces(
  scenarios: ScenarioResult[],
  metrics: Array<{ label: string; key: string }>,
  logScale: boolean,
): { traces: Plotly.Data[]; layout: Partial<Plotly.Layout> } {
  const traces = scenarios.flatMap((s, i) =>
    metrics.map((m, mi) => {
      const ci = s.aggregated[
        m.key as keyof AggregatedMetrics
      ] as ConfidenceInterval;
      const hrs = ci.mean / 3600;
      const lowHrs = ci.low / 3600;
      const highHrs = ci.high / 3600;
      return {
        type: 'bar', name: s.scenarioName,
        x: [m.label], y: [hrs],
        text: [hrs.toFixed(3) + 'h'],
        textposition: 'outside',
        textfont: { size: 10 },
        error_y: logScale ? undefined : {
          type: 'data', symmetric: false,
          array: [highHrs - hrs],
          arrayminus: [hrs - lowHrs],
          color: '#555', thickness: 1.5, width: 3,
        },
        marker: {
          color: FORMULA_COLORS[
            i % FORMULA_COLORS.length
          ],
        },
        legendgroup: s.scenarioName,
        showlegend: mi === 0,
      };
    }),
  );
  const yaxis: Record<string, unknown> = {
    title: {
      text: logScale ? 'Hours (log)' : 'Hours',
      standoff: 8,
    },
    gridcolor: '#f0f0f0',
  };
  if (logScale) yaxis.type = 'log';
  else yaxis.rangemode = 'tozero';
  return {
    traces,
    layout: {
      font: {
        family: 'Helvetica, Arial, sans-serif',
        size: 11,
      },
      margin: { t: 28, r: 16, b: 44, l: 60 },
      barmode: 'group', bargap: 0.25,
      bargroupgap: 0.12,
      legend: {
        orientation: 'h', y: -0.25, x: 0.5,
        xanchor: 'center', font: { size: 10 },
      },
      yaxis,
    },
  } as ChartBundle;
}

function buildOrgWaitTraces(
  scenarios: ScenarioResult[],
  orgIds: string[],
): { traces: Plotly.Data[]; layout: Partial<Plotly.Layout> } {
  const traces = scenarios.map((s, i) => {
    const yVals = orgIds.map((oid) =>
      Number(
        (
          (s.aggregated.orgMetrics[oid]
            ?.meanWaitTime.mean ?? 0) / 3600
        ).toFixed(3),
      ),
    );
    return {
      type: 'bar', name: s.scenarioName,
      x: orgIds, y: yVals,
      text: yVals.map((v) => v.toFixed(3) + 'h'),
      textposition: 'outside',
      textfont: { size: 10 },
      marker: {
        color: FORMULA_COLORS[
          i % FORMULA_COLORS.length
        ],
      },
    };
  });
  return {
    traces,
    layout: {
      font: {
        family: 'Helvetica, Arial, sans-serif',
        size: 11,
      },
      margin: { t: 28, r: 16, b: 44, l: 60 },
      barmode: 'group', bargap: 0.25,
      bargroupgap: 0.12,
      legend: {
        orientation: 'h', y: -0.25, x: 0.5,
        xanchor: 'center', font: { size: 10 },
      },
      yaxis: {
        title: { text: 'Hours', standoff: 8 },
        rangemode: 'tozero',
        gridcolor: '#f0f0f0',
      },
      xaxis: { tickfont: { size: 10 } },
    },
  } as ChartBundle;
}

function buildUtilTraces(
  scenarios: ScenarioResult[],
  poolTypes: string[],
): { traces: Plotly.Data[]; layout: Partial<Plotly.Layout> } {
  const cats: string[] = [];
  for (const pt of poolTypes) {
    cats.push(`${pt} CPU`);
    if (
      scenarios.some(
        (s) =>
          s.aggregated.utilization[pt]
            .gpu.mean > 0,
      )
    ) cats.push(`${pt} GPU`);
  }
  const traces = scenarios.map((s, i) => {
    const yVals = cats.map((cat) => {
      const [pool, resource] = cat.split(' ');
      const key =
        resource.toLowerCase() as 'cpu' | 'gpu';
      return Number(
        (
          s.aggregated.utilization[pool][key]
            .mean * 100
        ).toFixed(1),
      );
    });
    return {
      type: 'bar', name: s.scenarioName,
      x: cats, y: yVals,
      text: yVals.map((v) => v.toFixed(1) + '%'),
      textposition: 'outside',
      textfont: { size: 10 },
      marker: {
        color: FORMULA_COLORS[
          i % FORMULA_COLORS.length
        ],
      },
    };
  });
  return {
    traces,
    layout: {
      font: {
        family: 'Helvetica, Arial, sans-serif',
        size: 11,
      },
      margin: { t: 28, r: 16, b: 44, l: 60 },
      barmode: 'group', bargap: 0.25,
      bargroupgap: 0.12,
      legend: {
        orientation: 'h', y: -0.3, x: 0.5,
        xanchor: 'center', font: { size: 10 },
      },
      yaxis: {
        title: { text: '%', standoff: 8 },
        range: [0, 115],
        gridcolor: '#f0f0f0',
      },
      xaxis: { tickfont: { size: 10 } },
    },
  } as ChartBundle;
}

// ── Helper functions for academic report ──────

const generateAbstract = (
  tally: WinTally,
  entries: MultiScenarioEntry[],
): string => {
  const formulaCount = tally.formulaNames.length;
  const scenarioCount = entries.length;
  const totalRuns = entries.reduce(
    (acc, e) =>
      acc +
      e.result.scenarios.length *
        (e.result.scenarios[0]?.aggregated.runs ?? 0),
    0,
  );
  const bestFormula = tally.bestFormulas[0] ?? 'Unknown';
  const bestWins =
    tally.overallWins[bestFormula] ?? 0;

  const firstScenarioMetrics =
    entries[0]?.result.scenarios[0]?.aggregated;

  let keyMetric = 'throughput metrics';
  if (
    firstScenarioMetrics &&
    firstScenarioMetrics.throughput.mean > 0
  ) {
    keyMetric = `throughput of ` +
      `${firstScenarioMetrics.throughput.mean.toFixed(1)} ` +
      `jobs/min`;
  }

  return (
    `This report presents a comparative ` +
    `evaluation of ${formulaCount} scheduling formulas ` +
    `across ${scenarioCount} benchmark scenarios, ` +
    `totaling ${totalRuns} simulation runs. ` +
    `The evaluation measures performance ` +
    `(throughput, wait times), fairness ` +
    `(Jain's Fairness Index, coefficient of variation), ` +
    `and resource utilization across diverse ` +
    `workload patterns. ${bestFormula} emerged as ` +
    `the top performer, winning ` +
    `${bestWins} of ${tally.totalContests} metric contests. ` +
    `Key findings include ${keyMetric} in leading ` +
    `scenarios. All comparisons include 95% confidence ` +
    `intervals with paired t-tests for ` +
    `statistical rigor.`
  );
};

const generateConclusion = (
  tally: WinTally,
): string => {
  const bestFormula = tally.bestFormulas[0] ?? 'Unknown';
  const bestWins =
    tally.overallWins[bestFormula] ?? 0;
  const totalContests = tally.totalContests;
  const winPercentage =
    ((bestWins / totalContests) * 100).toFixed(1);

  return (
    `${bestFormula} emerges as the most robust ` +
    `scheduling formula, demonstrating consistent ` +
    `performance across all tested scenarios ` +
    `with a ${winPercentage}% win rate. ` +
    `The analysis confirms that sophisticated ` +
    `scheduling strategies provide measurable ` +
    `improvements in both individual fairness and ` +
    `system-wide throughput. Production deployments ` +
    `should prioritize this formula for optimal ` +
    `cluster utilization and fair resource allocation.`
  );
};

const addSectionHeader = (
  doc: jsPDF,
  level: 1 | 2 | 3,
  text: string,
  y: number,
  margin: number,
  contentW: number,
): number => {
  let newY = y;
  const ensureSpace = (needed: number) => {
    const pageH = doc.internal.pageSize.getHeight();
    if (
      newY + needed >
      pageH - margin
    ) {
      doc.addPage();
      newY = margin;
    }
  };

  ensureSpace(level === 1 ? 20 : 14);
  const sizes = { 1: 14, 2: 12, 3: 10 };
  doc.setFontSize(sizes[level]);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text(text, margin, newY);
  newY += level === 1 ? 8 : 6;
  if (level === 1) {
    // Thin rule under H1
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(margin, newY - 3, margin + contentW, newY - 3);
    newY += 2;
  }
  return newY;
};

const addFigureCaption = (
  doc: jsPDF,
  figNum: number,
  caption: string,
  y: number,
  pageW: number,
): number => {
  doc.setFontSize(8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(85, 85, 85);
  const captionText = `Figure ${figNum}: ${caption}`;
  doc.text(captionText, pageW / 2, y, {
    align: 'center',
  });
  doc.setTextColor(0);
  doc.setFont('helvetica', 'normal');
  return y + 5;
};

// ── PDF generation ─────────────────────────────

export const exportPDFReport = async (
  entries: MultiScenarioEntry[],
): Promise<void> => {
  const jsPDFModule = await import('jspdf');
  const jsPDF =
    jsPDFModule.jsPDF ?? jsPDFModule.default;
  const autoTableModule =
    await import('jspdf-autotable');
  if (autoTableModule.applyPlugin) {
    autoTableModule.applyPlugin(jsPDF);
  }

  const tally = computeWinTally(entries);
  const { formulaNames, bestFormulas } = tally;
  const ts = new Date().toISOString();

  const _totalWallMs = entries.reduce(
    (acc, e) =>
      acc +
      (e.result.completedAt - e.result.startedAt),
    0,
  );
  const _totalRuns = entries.reduce(
    (acc, e) =>
      acc +
      e.result.scenarios.length *
        (e.result.scenarios[0]?.aggregated.runs ??
          0),
    0,
  );

  // eslint-disable-next-line
  const doc = new (jsPDF as any)({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentW = pageW - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    const pageH = doc.internal.pageSize.getHeight();
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const abstractText = generateAbstract(tally, entries);
  const conclusionText = generateConclusion(tally);
  let figNum = 1;

  // ── Title Page ──────────────────────────────
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('CRMQ Benchmark Report', pageW / 2, y, {
    align: 'center',
  });
  y += 12;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80);
  doc.text(
    `${entries.length} Scenarios · ` +
    `${formulaNames.length} Formulas`,
    pageW / 2, y, { align: 'center' },
  );
  y += 8;

  doc.setFontSize(10);
  doc.setTextColor(100);
  const dateStr = new Date(ts)
    .toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  doc.text(dateStr, pageW / 2, y, {
    align: 'center',
  });
  y += 12;

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Deep Origin', pageW / 2, y, {
    align: 'center',
  });
  doc.setTextColor(0);
  y += 20;

  // ── Abstract ─────────────────────────────────
  y = addSectionHeader(
    doc, 1, 'Abstract', y, margin, contentW,
  );

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40);
  doc.text(abstractText, margin, y, {
    maxWidth: contentW,
    align: 'justify',
  });
  const abstractHeight = doc.getTextDimensions(
    abstractText, { maxWidth: contentW },
  ).h;
  y += abstractHeight + 8;
  doc.setTextColor(0);

  // ── Executive Summary ────────────────────────
  y = addSectionHeader(
    doc, 1, 'Executive Summary', y, margin, contentW,
  );

  const bestWins =
    tally.overallWins[bestFormulas[0]] ?? 0;
  const winnerTitle =
    bestFormulas.length > 1
      ? 'Joint Top Performers'
      : 'Top Performance';
  const winnerName = bestFormulas.join(', ');
  const winnerSub =
    bestFormulas.length > 1
      ? `Each won ${bestWins}/${tally.totalContests} ` +
        `metric contests`
      : `Won ${bestWins}/${tally.totalContests} ` +
        `metric contests`;

  doc.setFillColor(245, 247, 250);
  doc.rect(margin, y, contentW, 16, 'F');
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30);
  doc.text(winnerTitle, margin + 4, y + 5);
  doc.setFontSize(11);
  doc.text(winnerName, margin + 4, y + 10);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(winnerSub, margin + 4, y + 14);
  y += 20;

  // Rankings table
  ensureSpace(20);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text('Formula Rankings', margin, y);
  y += 5;

  const sorted = [...formulaNames].sort(
    (a, b) =>
      (tally.overallWins[b] ?? 0) -
      (tally.overallWins[a] ?? 0),
  );
  const rankRows = sorted.map((fn, i) => {
    const wins = tally.overallWins[fn] ?? 0;
    let rank = 1;
    for (let j = 0; j < i; j++) {
      if (
        (tally.overallWins[sorted[j]] ?? 0) > wins
      ) rank = j + 2;
    }
    const medal =
      rank === 1 ? '#1' : rank === 2
        ? '#2' : rank === 3 ? '#3' : `#${rank}`;
    return [
      medal, fn,
      `${wins}/${tally.totalContests}`,
    ];
  });

  (doc as JsPDFWithAutoTable).autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Rank', 'Formula', 'Wins']],
    body: rankRows,
    ...academicTableStyle,
  });
  y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 8;

  // Winner Matrix
  ensureSpace(20);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text('Winner Matrix', margin, y);
  y += 5;

  const matrixHead = [
    'Scenario',
    ...METRICS.map((m) => m.label),
  ];
  const matrixBody = entries.map((e) => [
    e.preset.name,
    ...METRICS.map((m) => {
      const winners =
        tally.scenarioWinners[e.preset.id]
          ?.[m.key] ?? [];
      return winners.join(', ');
    }),
  ]);

  (doc as JsPDFWithAutoTable).autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    head: [matrixHead],
    body: matrixBody,
    ...academicTableStyle,
  });
  y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 8;

  // ── Methodology ──────────────────────────────
  y = addSectionHeader(
    doc, 1, '2. Methodology', y, margin, contentW,
  );

  for (const entry of entries) {
    const { preset } = entry;
    const wc = preset.workloadConfig;

    ensureSpace(18);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(preset.name, margin, y);
    y += 4;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80);
    doc.text(preset.description, margin, y, {
      maxWidth: contentW,
    });
    const descHeight = doc.getTextDimensions(
      preset.description, { maxWidth: contentW },
    ).h;
    y += descHeight + 3;

    const wkRows: string[][] = [
      [
        'Duration',
        fmtSec(wc.durationSeconds),
      ],
      [
        'Arrival Pattern',
        describeArrival(wc.arrivalPattern),
      ],
    ];
    if (
      wc.arrivalPattern.type !== 'periodic_mix'
    ) {
      wkRows.push([
        'Size Distribution',
        describeSize(wc.sizeDistribution),
      ]);
    }
    wkRows.push(['Random Seed', String(wc.seed)]);

    doc.setTextColor(0);
    (doc as JsPDFWithAutoTable).autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Parameter', 'Value']],
      body: wkRows,
      ...academicTableStyle,
    });
    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 6;
  }

  // ── Results Section ────────────────────────
  y = addSectionHeader(
    doc, 1, '3. Results', y, margin, contentW,
  );

  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei];
    const scenarios = entry.result.scenarios;
    const orgIds = Object.keys(
      scenarios[0]?.aggregated.orgMetrics ?? {},
    );
    const poolTypes = Object.keys(
      scenarios[0]?.aggregated.utilization ?? {},
    );

    ensureSpace(30);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(
      `${ei + 1}.${ei + 1} ${entry.preset.name}`,
      margin, y,
    );
    y += 6;

    // Radar
    const radar = buildRadarTraces(scenarios);
    const radarImg = await renderChartImage(
      radar.traces, radar.layout, 520, 340,
    );
    ensureSpace(80);
    doc.addImage(
      radarImg, 'PNG',
      margin, y, contentW, contentW * 0.62,
    );
    y += contentW * 0.62 + 2;
    y = addFigureCaption(
      doc, figNum++,
      `Formula Scorecard — ${entry.preset.name}`,
      y, pageW,
    );
    y += 4;

    // Throughput
    const tp = buildBarTraces(
      scenarios, 'throughput', 'Jobs / min',
    );
    const tpImg = await renderChartImage(
      tp.traces, tp.layout, 520, 260,
    );
    ensureSpace(65);
    doc.addImage(
      tpImg, 'PNG',
      margin, y, contentW, contentW * 0.47,
    );
    y += contentW * 0.47 + 2;
    y = addFigureCaption(
      doc, figNum++,
      `Throughput with 95% CI — ` +
        `${entry.preset.name}`,
      y, pageW,
    );
    y += 4;

    // Typical Wait
    const tw = buildGroupedWaitTraces(
      scenarios, [
        { label: 'Mean', key: 'meanWaitTime' },
        { label: 'P50', key: 'p50WaitTime' },
      ], false,
    );
    const twImg = await renderChartImage(
      tw.traces, tw.layout, 520, 260,
    );
    ensureSpace(65);
    doc.addImage(
      twImg, 'PNG',
      margin, y, contentW, contentW * 0.47,
    );
    y += contentW * 0.47 + 2;
    y = addFigureCaption(
      doc, figNum++,
      `Typical Wait Times — ` +
        `${entry.preset.name}`,
      y, pageW,
    );
    y += 4;

    // Tail Wait
    const tl = buildGroupedWaitTraces(
      scenarios, [
        { label: 'P95', key: 'p95WaitTime' },
        { label: 'P99', key: 'p99WaitTime' },
        { label: 'Max', key: 'maxWaitTime' },
      ], true,
    );
    const tlImg = await renderChartImage(
      tl.traces, tl.layout, 520, 260,
    );
    ensureSpace(65);
    doc.addImage(
      tlImg, 'PNG',
      margin, y, contentW, contentW * 0.47,
    );
    y += contentW * 0.47 + 2;
    y = addFigureCaption(
      doc, figNum++,
      `Tail Wait Times (log scale) — ` +
        `${entry.preset.name}`,
      y, pageW,
    );
    y += 4;

    // Fairness
    const fi = buildBarTraces(
      scenarios, 'jainsIndex',
      "Jain's Fairness Index",
    );
    const fiImg = await renderChartImage(
      fi.traces, fi.layout, 520, 240,
    );
    ensureSpace(60);
    doc.addImage(
      fiImg, 'PNG',
      margin, y, contentW, contentW * 0.43,
    );
    y += contentW * 0.43 + 2;
    y = addFigureCaption(
      doc, figNum++,
      `Jain's Fairness Index — ` +
        `${entry.preset.name}`,
      y, pageW,
    );
    y += 4;

    // Per-Org Wait
    if (orgIds.length > 0) {
      const ow = buildOrgWaitTraces(
        scenarios, orgIds,
      );
      const owImg = await renderChartImage(
        ow.traces, ow.layout, 520, 280,
      );
      ensureSpace(68);
      doc.addImage(
        owImg, 'PNG',
        margin, y, contentW, contentW * 0.50,
      );
      y += contentW * 0.50 + 2;
      y = addFigureCaption(
        doc, figNum++,
        `Per-Organization Mean Wait Time — ` +
          `${entry.preset.name}`,
        y, pageW,
      );
      y += 4;
    }

    // Utilization
    if (poolTypes.length > 0) {
      const ut = buildUtilTraces(
        scenarios, poolTypes,
      );
      const utImg = await renderChartImage(
        ut.traces, ut.layout, 520, 240,
      );
      ensureSpace(60);
      doc.addImage(
        utImg, 'PNG',
        margin, y, contentW, contentW * 0.43,
      );
      y += contentW * 0.43 + 2;
      y = addFigureCaption(
        doc, figNum++,
        `Cluster Utilization — ` +
          `${entry.preset.name}`,
        y, pageW,
      );
      y += 4;
    }
  }

  // ── Statistical Analysis ───────────────────
  y = addSectionHeader(
    doc, 1, '4. Statistical Analysis', y, margin, contentW,
  );

  const allComparisons = entries.flatMap(
    (e) => e.result.comparisons,
  );
  if (allComparisons.length > 0) {
    for (const c of allComparisons) {
      ensureSpace(16);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0);
      doc.text(
        `${c.nameA} vs ${c.nameB} (n=${c.throughput.n})`,
        margin, y,
      );
      y += 4;

      const cmpRows = [
        {
          label: 'Throughput',
          test: c.throughput,
          winner: c.winners['throughput'],
        },
        {
          label: 'Mean Wait',
          test: c.meanWaitTime,
          winner: c.winners['meanWaitTime'],
        },
        {
          label: 'P95 Wait',
          test: c.p95WaitTime,
          winner: c.winners['p95WaitTime'],
        },
        {
          label: "Jain's FI",
          test: c.jainsIndex,
          winner: c.winners['jainsIndex'],
        },
      ].map((cm) => {
        const pStr =
          cm.test.pValue < 0.001
            ? '<0.001'
            : fmtNum(cm.test.pValue, 4);
        const dStr =
          cm.test.cohensD >= 1e5
            ? 'deterministic'
            : `${cm.test.effectLabel} ` +
              `(d=${fmtNum(cm.test.cohensD)})`;
        const eff = cm.test.significant
          ? dStr : 'ns';
        return [
          cm.label,
          fmtNum(cm.test.tStatistic, 3),
          pStr, eff, cm.winner,
        ];
      });

      (doc as JsPDFWithAutoTable).autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [[
          'Metric', 't-statistic', 'p-value',
          'Effect', 'Winner',
        ]],
        body: cmpRows,
        ...academicTableStyle,
      });
      y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 6;
    }
  }

  // ── Conclusion ──────────────────────────────
  y = addSectionHeader(
    doc, 1, '5. Conclusion', y, margin, contentW,
  );

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40);
  doc.text(conclusionText, margin, y, {
    maxWidth: contentW,
    align: 'justify',
  });
  const conclusionHeight = doc.getTextDimensions(
    conclusionText, { maxWidth: contentW },
  ).h;
  y += conclusionHeight + 8;
  doc.setTextColor(0);

  // ── Footer ──────────────────────────────────
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(150);
  doc.text(
    'Generated by CRMQ Benchmark Simulator' +
    ' — Deep Origin',
    pageW / 2, pageH - 8,
    { align: 'center' },
  );

  doc.save(
    `crmq_benchmark_report_${timestamp()}.pdf`,
  );
};

// Consolidated Markdown Report
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const exportMarkdownReport = (
  entries: MultiScenarioEntry[],
): void => {
  const tally = computeWinTally(entries);
  const {
    formulaNames,
    bestFormulas,
    overallWins,
    scenarioWinners,
    totalContests,
  } = tally;

  const _totalWallMs = entries.reduce(
    (acc, e) =>
      acc +
      (e.result.completedAt - e.result.startedAt),
    0,
  );
  const _totalRuns = entries.reduce(
    (acc, e) =>
      acc +
      e.result.scenarios.length *
        (e.result.scenarios[0]?.aggregated.runs ??
          0),
    0,
  );

  const lines: string[] = [];
  const abstractText = generateAbstract(tally, entries);
  const conclusionText = generateConclusion(tally);

  // Metadata block
  lines.push(`# CRMQ Benchmark Report`);
  lines.push('');
  lines.push(
    `**Author**: CRMQ Benchmark Simulator — ` +
    `Deep Origin`,
  );
  lines.push(
    `**Date**: ` +
    `${new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })}`,
  );
  lines.push(`**Version**: 1.0`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Abstract
  lines.push(`## Abstract`);
  lines.push('');
  lines.push(abstractText);
  lines.push('');

  // Executive Summary
  lines.push(`## Executive Summary`);
  lines.push('');
  const bestWins =
    overallWins[bestFormulas[0]] ?? 0;
  if (bestFormulas.length > 1) {
    lines.push(
      `**Joint Top Performers**: ` +
      `${bestFormulas.join(', ')} ` +
      `— each won ${bestWins}/${totalContests} ` +
      `metric contests`,
    );
  } else {
    lines.push(
      `**Top Performer**: **${bestFormulas[0]}** ` +
      `won ${bestWins}/${totalContests} ` +
      `metric contests`,
    );
  }
  lines.push('');

  lines.push(`### Formula Rankings`);
  lines.push('');
  const sorted = [...formulaNames].sort(
    (a, b) =>
      (overallWins[b] ?? 0) -
      (overallWins[a] ?? 0),
  );
  lines.push(`| Rank | Formula | Wins |`);
  lines.push(`| --- | --- | --- |`);
  sorted.forEach((fn, i) => {
    const wins = overallWins[fn] ?? 0;
    let rank = 1;
    for (let j = 0; j < i; j++) {
      if (
        (overallWins[sorted[j]] ?? 0) > wins
      ) {
        rank = j + 2;
      }
    }
    const medal =
      rank === 1
        ? '🥇'
        : rank === 2
          ? '🥈'
          : rank === 3
            ? '🥉'
            : `#${rank}`;
    lines.push(
      `| ${medal} | ${fn} ` +
      `| ${wins}/${totalContests} |`,
    );
  });
  lines.push('');

  lines.push(`### Winner Matrix`);
  lines.push('');
  const mHeader = METRICS.map(
    (m) => m.label,
  ).join(' | ');
  lines.push(`| Scenario | ${mHeader} |`);
  lines.push(
    `| --- | ${METRICS.map(() => '---').join(' | ')} |`,
  );
  for (const e of entries) {
    const cells = METRICS.map((m) => {
      const winners =
        scenarioWinners[e.preset.id]?.[m.key] ??
        [];
      return winners.join(', ');
    }).join(' | ');
    lines.push(
      `| ${e.preset.name} | ${cells} |`,
    );
  }
  lines.push('');

  // Methodology
  lines.push(`## 2. Methodology`);
  lines.push('');

  // Per-scenario details
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { preset } = entry;
    const wc = preset.workloadConfig;

    lines.push(
      `### 2.${i + 1} ${preset.name}`,
    );
    lines.push('');
    lines.push(`${preset.description}`);
    lines.push('');

    // Workload config
    lines.push(`#### Workload Configuration`);
    lines.push('');
    lines.push(`| Parameter | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(
      `| Duration | ${fmtSec(wc.durationSeconds)} |`,
    );
    lines.push(
      `| Arrival Pattern | ` +
      `${describeArrival(wc.arrivalPattern)} |`,
    );
    if (wc.arrivalPattern.type !== 'periodic_mix') {
      lines.push(
        `| Size Distribution | ` +
        `${describeSize(wc.sizeDistribution)} |`,
      );
    }
    lines.push(
      `| Random Seed | ${wc.seed} |`,
    );
    lines.push('');

    // Job templates for periodic_mix
    if (wc.arrivalPattern.type === 'periodic_mix') {
      lines.push('### Job Templates');
      lines.push('');
      lines.push(
        '| Job Type | Org | CPU | Mem | GPU ' +
        '| Duration | Interval | Est. Count |',
      );
      lines.push(
        '| --- | --- | --- | --- | --- ' +
        '| --- | --- | --- |',
      );
      for (const t of wc.arrivalPattern.templates) {
        const est = Math.floor(
          wc.durationSeconds / t.intervalSeconds,
        );
        lines.push(
          `| ${t.name} | ${t.orgId} ` +
          `| ${vcpuFromCpuMillis(t.cpuMillis)} | ` +
          `${gbFromMemoryMiB(t.memoryMiB)} ` +
          `| ${t.gpu} ` +
          `| ${fmtSec(t.durationSeconds)} ` +
          `| every ${fmtSec(t.intervalSeconds)} ` +
          `| ${est} |`,
        );
      }
      lines.push('');
    }

  }

  // Results Section
  lines.push(`## 3. Results`);
  lines.push('');

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { result, preset } = entry;
    const scenarios = result.scenarios;

    lines.push(
      `### 3.${i + 1} ${preset.name} — ` +
      `Overview Metrics`,
    );
    lines.push('');

    const oHeader = scenarios
      .map((s) => s.scenarioName)
      .join(' | ');
    lines.push(`| Metric | ${oHeader} |`);
    lines.push(
      `| --- | ` +
      `${scenarios.map(() => '---').join(' | ')} |`,
    );

    const mdMetrics: Array<{
      label: string;
      extract: (a: AggregatedMetrics) => string;
    }> = [
      {
        label: 'Throughput (jobs/min)',
        extract: (a) => ciStr(a.throughput),
      },
      {
        label: 'Mean Wait Time',
        extract: (a) =>
          ciTimeStr(a.meanWaitTime),
      },
      {
        label: 'P50 Wait Time',
        extract: (a) =>
          ciTimeStr(a.p50WaitTime),
      },
      {
        label: 'P95 Wait Time',
        extract: (a) =>
          ciTimeStr(a.p95WaitTime),
      },
      {
        label: 'P99 Wait Time',
        extract: (a) =>
          ciTimeStr(a.p99WaitTime),
      },
      {
        label: 'Max Wait Time',
        extract: (a) =>
          ciTimeStr(a.maxWaitTime),
      },
      {
        label: "Jain's Fairness Index",
        extract: (a) => ciStr(a.jainsIndex),
      },
      {
        label: 'Wait Time CoV',
        extract: (a) =>
          ciStr(a.coefficientOfVariation),
      },
    ];

    for (const r of mdMetrics) {
      const vals = scenarios
        .map((s) => r.extract(s.aggregated))
        .join(' | ');
      lines.push(`| ${r.label} | ${vals} |`);
    }
    lines.push('');

    // Per-formula details
    for (const s of scenarios) {
      const a = s.aggregated;
      lines.push(`#### ${s.scenarioName}`);
      lines.push('');
      const avgDur =
        s.runStats.reduce(
          (acc, r) => acc + r.simDuration,
          0,
        ) / s.runStats.length;
      const avgWarmUp =
        s.runStats.reduce(
          (acc, r) => acc + r.warmUpTime,
          0,
        ) / s.runStats.length;
      lines.push(
        `- **Runs**: ${a.runs}  ` +
        `**Avg Duration**: ${fmtSec(avgDur)}  ` +
        `**Avg Warm-up**: ${fmtSec(avgWarmUp)}`,
      );
      lines.push('');

      const poolTypes = Object.keys(a.utilization);
      if (poolTypes.length > 0) {
        lines.push(`**Resource Utilization**:`);
        for (const pt of poolTypes) {
          lines.push(
            `- ${pt}: CPU ` +
            `${ciPctStr(a.utilization[pt].cpu)}, ` +
            `GPU ` +
            `${ciPctStr(a.utilization[pt].gpu)}`,
          );
        }
        lines.push('');
      }

      const orgIds = Object.keys(a.orgMetrics);
      if (orgIds.length > 0) {
        lines.push(`**Per-Organization Metrics**:`);
        lines.push('');
        lines.push(
          `| Organization | ` +
          `Mean Wait | Jobs Completed |`,
        );
        lines.push(`| --- | --- | --- |`);
        for (const orgId of orgIds) {
          lines.push(
            `| ${orgId} ` +
            `| ${ciTimeStr(a.orgMetrics[orgId].meanWaitTime)} ` +
            `| ${ciStr(a.orgMetrics[orgId].jobsCompleted)} |`,
          );
        }
        lines.push('');
      }
    }
  }

  // Statistical Analysis Section
  const allComparisons = entries.flatMap(
    (e) => e.result.comparisons,
  );
  if (allComparisons.length > 0) {
    lines.push(`## 4. Statistical Analysis`);
    lines.push('');

    for (const c of allComparisons) {
      lines.push(
        `### ${c.nameA} vs ${c.nameB}`,
      );
      lines.push('');
      lines.push(
        `(n=${c.throughput.n} observations)`,
      );
      lines.push('');
      lines.push(
        '| Metric | t-statistic | p-value ' +
        '| Effect | Winner |',
      );
      lines.push(
        '| --- | --- | --- | --- | --- |',
      );
      const cms = [
        {
          label: 'Throughput',
          test: c.throughput,
          winner: c.winners['throughput'],
        },
        {
          label: 'Mean Wait',
          test: c.meanWaitTime,
          winner: c.winners['meanWaitTime'],
        },
        {
          label: 'P95 Wait',
          test: c.p95WaitTime,
          winner: c.winners['p95WaitTime'],
        },
        {
          label: "Jain's Fairness",
          test: c.jainsIndex,
          winner: c.winners['jainsIndex'],
        },
      ];
      for (const cm of cms) {
        const pStr =
          cm.test.pValue < 0.001
            ? '<0.001'
            : fmtNum(cm.test.pValue, 4);
        const dStr =
          cm.test.cohensD >= 1e5
            ? 'deterministic'
            : `${cm.test.effectLabel} ` +
              `(d=${fmtNum(cm.test.cohensD)})`;
        const eff = cm.test.significant
          ? dStr
          : 'ns';
        lines.push(
          `| ${cm.label} ` +
          `| ${fmtNum(cm.test.tStatistic, 2)} ` +
          `| ${pStr} | ${eff} ` +
          `| ${cm.winner} |`,
        );
      }
      lines.push('');
    }
  }

  // Conclusion Section
  lines.push(`## 5. Conclusion`);
  lines.push('');
  lines.push(conclusionText);
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    `*Generated by CRMQ Benchmark Simulator — ` +
    `Deep Origin*`,
  );

  const md = lines.join('\n');
  download(
    md,
    `crmq_benchmark_report_${timestamp()}.md`,
    'text/markdown;charset=utf-8',
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Consolidated JSON Report
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const exportJSONReport = (
  entries: MultiScenarioEntry[],
): void => {
  const tally = computeWinTally(entries);
  const exportData = {
    exportedAt: new Date().toISOString(),
    scenarioCount: entries.length,
    formulaCount:
      entries[0]?.result.scenarios.length ?? 0,
    summary: {
      bestFormulas: tally.bestFormulas,
      totalContests: tally.totalContests,
      overallWins: tally.overallWins,
      winTally: tally.winTally,
    },
    scenarios: entries.map((e) => ({
      preset: {
        id: e.preset.id,
        name: e.preset.name,
        description: e.preset.description,
        phase: e.preset.phase,
        config: e.preset.workloadConfig,
      },
      wallClockMs:
        e.result.completedAt -
        e.result.startedAt,
      formulas: e.result.scenarios.map((s) => ({
        id: s.scenarioId,
        name: s.scenarioName,
        runs: s.aggregated.runs,
        aggregated: s.aggregated,
        runStats: s.runStats,
      })),
      comparisons: e.result.comparisons,
    })),
  };

  const json = JSON.stringify(exportData, null, 2);
  download(
    json,
    `crmq_benchmark_report_${timestamp()}.json`,
    'application/json',
  );
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Consolidated CSV Report
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const escCsv = (v: string | number): string => {
  const s = String(v);
  return s.includes(',') ||
    s.includes('"') ||
    s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

export const exportCSVReport = (
  entries: MultiScenarioEntry[],
): void => {
  const tally = computeWinTally(entries);
  const { formulaNames } = tally;
  const rows: string[][] = [];

  rows.push([
    'CRMQ Benchmark Report — ' +
    `${entries.length} scenarios × ` +
    `${formulaNames.length} formulas`,
  ]);
  rows.push([]);

  // Summary row for each scenario
  for (const entry of entries) {
    const { result, preset } = entry;
    const scenarios = result.scenarios;

    rows.push([
      `Scenario: ${preset.name} ` +
      `(Phase ${preset.phase})`,
    ]);
    rows.push([]);

    // Header
    rows.push([
      'Metric',
      ...scenarios.map((s) => s.scenarioName),
    ]);

    const metrics: Array<{
      label: string;
      extract: (a: AggregatedMetrics) => string;
    }> = [
      {
        label: 'Throughput (jobs/min)',
        extract: (a) => fmtNum(a.throughput.mean),
      },
      {
        label: 'Throughput CI',
        extract: (a) => ciStr(a.throughput),
      },
      {
        label: 'Mean Wait Time (s)',
        extract: (a) =>
          fmtNum(a.meanWaitTime.mean),
      },
      {
        label: 'Mean Wait Time CI',
        extract: (a) =>
          ciTimeStr(a.meanWaitTime),
      },
      {
        label: 'P50 Wait Time (s)',
        extract: (a) =>
          fmtNum(a.p50WaitTime.mean),
      },
      {
        label: 'P95 Wait Time (s)',
        extract: (a) =>
          fmtNum(a.p95WaitTime.mean),
      },
      {
        label: 'P99 Wait Time (s)',
        extract: (a) =>
          fmtNum(a.p99WaitTime.mean),
      },
      {
        label: 'Max Wait Time (s)',
        extract: (a) =>
          fmtNum(a.maxWaitTime.mean),
      },
      {
        label: "Jain's Fairness Index",
        extract: (a) =>
          fmtNum(a.jainsIndex.mean),
      },
      {
        label: 'Wait Time CoV',
        extract: (a) =>
          fmtNum(a.coefficientOfVariation.mean),
      },
    ];

    for (const m of metrics) {
      rows.push([
        m.label,
        ...scenarios.map((s) =>
          m.extract(s.aggregated),
        ),
      ]);
    }

    // Per-org metrics
    if (scenarios.length > 0) {
      const orgIds = Object.keys(
        scenarios[0].aggregated.orgMetrics,
      );
      if (orgIds.length > 0) {
        rows.push([]);
        rows.push(['Per-Org Metrics']);
        for (const orgId of orgIds) {
          rows.push([
            `${orgId} — Mean Wait (s)`,
            ...scenarios.map((s) =>
              fmtNum(
                s.aggregated.orgMetrics[orgId]
                  ?.meanWaitTime.mean ?? 0,
              ),
            ),
          ]);
          rows.push([
            `${orgId} — Jobs Completed`,
            ...scenarios.map((s) =>
              fmtNum(
                s.aggregated.orgMetrics[orgId]
                  ?.jobsCompleted.mean ?? 0,
              ),
            ),
          ]);
        }
      }
    }

    // Statistical comparisons
    if (result.comparisons.length > 0) {
      rows.push([]);
      rows.push([
        'Statistical Comparisons (Paired t-test)',
      ]);
      rows.push([
        'Pair',
        'Metric',
        't-statistic',
        'p-value',
        "Cohen's d",
        'Effect',
        'Significant',
        'Winner',
      ]);
      for (const c of result.comparisons) {
        const pair =
          `${c.nameA} vs ${c.nameB}`;
        const compMetrics = [
          {
            label: 'Throughput',
            test: c.throughput,
            winner: c.winners['throughput'],
          },
          {
            label: 'Mean Wait Time',
            test: c.meanWaitTime,
            winner: c.winners['meanWaitTime'],
          },
          {
            label: 'P95 Wait Time',
            test: c.p95WaitTime,
            winner: c.winners['p95WaitTime'],
          },
          {
            label: "Jain's Fairness",
            test: c.jainsIndex,
            winner: c.winners['jainsIndex'],
          },
        ];
        for (const cm of compMetrics) {
          rows.push([
            pair,
            cm.label,
            fmtNum(cm.test.tStatistic, 3),
            cm.test.pValue < 0.001
              ? '<0.001'
              : fmtNum(cm.test.pValue, 4),
            cm.test.cohensD >= 1e5
              ? 'deterministic'
              : fmtNum(cm.test.cohensD),
            cm.test.effectLabel,
            cm.test.significant ? 'yes' : 'no',
            cm.winner,
          ]);
        }
      }
    }

    rows.push([]);
    rows.push([]);
  }

  const csv = rows
    .map((r) => r.map(escCsv).join(','))
    .join('\n');
  download(
    csv,
    `crmq_benchmark_report_${timestamp()}.csv`,
    'text/csv;charset=utf-8',
  );
};
