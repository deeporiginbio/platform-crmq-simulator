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
  PairedTestResult,
  ScenarioComparison,
} from './statistics';
import type {
  ScenarioPreset,
  ArrivalPattern,
  JobSizeDistribution,
} from './traffic';

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
      traces as any,
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
): { traces: any[]; layout: any } {
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
  return { traces, layout };
}

function buildBarTraces(
  scenarios: ScenarioResult[],
  getter: string,
  yTitle: string,
): { traces: any[]; layout: any } {
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
  };
}

function buildGroupedWaitTraces(
  scenarios: ScenarioResult[],
  metrics: Array<{ label: string; key: string }>,
  logScale: boolean,
): { traces: any[]; layout: any } {
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
  };
}

function buildOrgWaitTraces(
  scenarios: ScenarioResult[],
  orgIds: string[],
): { traces: any[]; layout: any } {
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
  };
}

function buildUtilTraces(
  scenarios: ScenarioResult[],
  poolTypes: string[],
): { traces: any[]; layout: any } {
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
  };
}

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

  const totalWallMs = entries.reduce(
    (acc, e) =>
      acc +
      (e.result.completedAt - e.result.startedAt),
    0,
  );
  const totalRuns = entries.reduce(
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
  const margin = 14;
  const contentW = pageW - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    const pageH = doc.internal.pageSize.getHeight();
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // ── Title ───────────────────────────────────
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('CRMQ Benchmark Report', margin, y);
  y += 8;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(
    `${entries.length} scenarios x ` +
    `${formulaNames.length} formulas — ` +
    `${totalRuns} total runs in ` +
    `${(totalWallMs / 1000).toFixed(1)}s — ` +
    `${ts}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 8;

  // ── Overall Winner ──────────────────────────
  const bestWins =
    tally.overallWins[bestFormulas[0]] ?? 0;
  const winnerTitle =
    bestFormulas.length > 1
      ? 'Tied for Best Overall'
      : 'Best Overall Formula';
  const winnerName = bestFormulas.join('  ·  ');
  const winnerSub =
    bestFormulas.length > 1
      ? `Each won ${bestWins}/${tally.totalContests} metric contests`
      : `Won ${bestWins}/${tally.totalContests} metric contests`;

  doc.setFillColor(243, 240, 255);
  doc.roundedRect(
    margin, y, contentW, 18, 3, 3, 'F',
  );
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(109, 40, 217);
  doc.text(winnerTitle, margin + 4, y + 5);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text(winnerName, margin + 4, y + 11);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(winnerSub, margin + 4, y + 16);
  doc.setTextColor(0);
  y += 24;

  // ── Formula Rankings ────────────────────────
  ensureSpace(20);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Formula Rankings', margin, y);
  y += 6;

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

  (doc as any).autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Rank', 'Formula', 'Wins']],
    body: rankRows,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: {
      fillColor: [248, 249, 250],
      textColor: [50, 50, 50],
      fontStyle: 'bold',
    },
  });
  y = (doc as any).lastAutoTable.finalY + 8;

  // ── Winner Matrix ───────────────────────────
  ensureSpace(20);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Winner Matrix', margin, y);
  y += 6;

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

  (doc as any).autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    head: [matrixHead],
    body: matrixBody,
    theme: 'grid',
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: {
      fillColor: [248, 249, 250],
      textColor: [50, 50, 50],
      fontStyle: 'bold',
    },
    columnStyles: { 0: { fontStyle: 'bold' } },
  });
  y = (doc as any).lastAutoTable.finalY + 8;

  // ── Charts (rendered as images) ─────────────
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
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(
      `Charts — ${entry.preset.name}`,
      margin, y,
    );
    y += 6;

    // Radar
    const radar = buildRadarTraces(scenarios);
    const radarImg = await renderChartImage(
      radar.traces, radar.layout, 520, 340,
    );
    ensureSpace(68);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Formula Scorecard', margin, y);
    y += 3;
    doc.addImage(
      radarImg, 'PNG',
      margin, y, contentW, contentW * 0.62,
    );
    y += contentW * 0.62 + 4;

    // Throughput
    const tp = buildBarTraces(
      scenarios, 'throughput', 'Jobs / min',
    );
    const tpImg = await renderChartImage(
      tp.traces, tp.layout, 520, 260,
    );
    ensureSpace(55);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(
      'Throughput (95% CI)', margin, y,
    );
    y += 3;
    doc.addImage(
      tpImg, 'PNG',
      margin, y, contentW, contentW * 0.47,
    );
    y += contentW * 0.47 + 4;

    // Typical Wait
    const tw = buildGroupedWaitTraces(scenarios, [
      { label: 'Mean', key: 'meanWaitTime' },
      { label: 'P50', key: 'p50WaitTime' },
    ], false);
    const twImg = await renderChartImage(
      tw.traces, tw.layout, 520, 260,
    );
    ensureSpace(55);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(
      'Typical Wait (Mean & P50)', margin, y,
    );
    y += 3;
    doc.addImage(
      twImg, 'PNG',
      margin, y, contentW, contentW * 0.47,
    );
    y += contentW * 0.47 + 4;

    // Tail Wait
    const tl = buildGroupedWaitTraces(scenarios, [
      { label: 'P95', key: 'p95WaitTime' },
      { label: 'P99', key: 'p99WaitTime' },
      { label: 'Max', key: 'maxWaitTime' },
    ], true);
    const tlImg = await renderChartImage(
      tl.traces, tl.layout, 520, 260,
    );
    ensureSpace(55);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(
      'Tail Wait (P95/P99/Max, log)',
      margin, y,
    );
    y += 3;
    doc.addImage(
      tlImg, 'PNG',
      margin, y, contentW, contentW * 0.47,
    );
    y += contentW * 0.47 + 4;

    // Fairness
    const fi = buildBarTraces(
      scenarios, 'jainsIndex',
      "Jain's Fairness Index",
    );
    const fiImg = await renderChartImage(
      fi.traces, fi.layout, 520, 240,
    );
    ensureSpace(52);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(
      "Jain's Fairness Index", margin, y,
    );
    y += 3;
    doc.addImage(
      fiImg, 'PNG',
      margin, y, contentW, contentW * 0.43,
    );
    y += contentW * 0.43 + 4;

    // Per-Org Wait
    if (orgIds.length > 0) {
      const ow = buildOrgWaitTraces(
        scenarios, orgIds,
      );
      const owImg = await renderChartImage(
        ow.traces, ow.layout, 520, 280,
      );
      ensureSpace(58);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text(
        'Per-Org Mean Wait Time',
        margin, y,
      );
      y += 3;
      doc.addImage(
        owImg, 'PNG',
        margin, y, contentW, contentW * 0.50,
      );
      y += contentW * 0.50 + 4;
    }

    // Utilization
    if (poolTypes.length > 0) {
      const ut = buildUtilTraces(
        scenarios, poolTypes,
      );
      const utImg = await renderChartImage(
        ut.traces, ut.layout, 520, 240,
      );
      ensureSpace(50);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text(
        'Cluster Utilization', margin, y,
      );
      y += 3;
      doc.addImage(
        utImg, 'PNG',
        margin, y, contentW, contentW * 0.43,
      );
      y += contentW * 0.43 + 4;
    }
  }

  // ── Per-Scenario Detail Tables ──────────────
  for (const entry of entries) {
    const { result, preset } = entry;
    const scenarios = result.scenarios;
    const wc = preset.workloadConfig;
    const dur = (
      (result.completedAt - result.startedAt) /
      1000
    ).toFixed(1);

    ensureSpace(30);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(
      `${preset.name} (Phase ${preset.phase})`,
      margin, y,
    );
    y += 5;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(
      `${preset.description} — ` +
      `${scenarios.length} formulas x ` +
      `${scenarios[0]?.aggregated.runs ?? 0} ` +
      `runs in ${dur}s`,
      margin, y, { maxWidth: contentW },
    );
    doc.setTextColor(0);
    y += 8;

    // Workload config table
    const wkRows: string[][] = [
      ['Duration', fmtSec(wc.durationSeconds)],
      [
        'Arrival',
        describeArrival(wc.arrivalPattern),
      ],
    ];
    if (
      wc.arrivalPattern.type !== 'periodic_mix'
    ) {
      wkRows.push([
        'Size Dist.',
        describeSize(wc.sizeDistribution),
      ]);
    }
    wkRows.push(['Seed', String(wc.seed)]);

    (doc as any).autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Parameter', 'Value']],
      body: wkRows,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: {
        fillColor: [248, 249, 250],
        textColor: [50, 50, 50],
        fontStyle: 'bold',
      },
    });
    y = (doc as any).lastAutoTable.finalY + 6;

    // Overview metrics
    ensureSpace(20);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Overview Metrics', margin, y);
    y += 4;

    const overviewHead = [
      'Metric',
      ...scenarios.map((s) => s.scenarioName),
    ];
    const oRows: string[][] = [
      [
        'Throughput (jobs/min)',
        ...scenarios.map((s) =>
          ciStr(s.aggregated.throughput),
        ),
      ],
      [
        'Mean Wait Time',
        ...scenarios.map((s) =>
          ciTimeStr(s.aggregated.meanWaitTime),
        ),
      ],
      [
        'P50 Wait Time',
        ...scenarios.map((s) =>
          ciTimeStr(s.aggregated.p50WaitTime),
        ),
      ],
      [
        'P95 Wait Time',
        ...scenarios.map((s) =>
          ciTimeStr(s.aggregated.p95WaitTime),
        ),
      ],
      [
        'P99 Wait Time',
        ...scenarios.map((s) =>
          ciTimeStr(s.aggregated.p99WaitTime),
        ),
      ],
      [
        'Max Wait Time',
        ...scenarios.map((s) =>
          ciTimeStr(s.aggregated.maxWaitTime),
        ),
      ],
      [
        "Jain's Fairness",
        ...scenarios.map((s) =>
          ciStr(s.aggregated.jainsIndex),
        ),
      ],
      [
        'Wait Time CoV',
        ...scenarios.map((s) =>
          ciStr(
            s.aggregated.coefficientOfVariation,
          ),
        ),
      ],
    ];

    (doc as any).autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [overviewHead],
      body: oRows,
      theme: 'grid',
      styles: { fontSize: 6.5, cellPadding: 2 },
      headStyles: {
        fillColor: [248, 249, 250],
        textColor: [50, 50, 50],
        fontStyle: 'bold',
        fontSize: 6.5,
      },
      columnStyles: { 0: { fontStyle: 'bold' } },
    });
    y = (doc as any).lastAutoTable.finalY + 6;

    // Statistical comparisons
    if (result.comparisons.length > 0) {
      ensureSpace(20);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(
        'Statistical Comparisons', margin, y,
      );
      y += 4;

      for (const c of result.comparisons) {
        ensureSpace(16);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.text(
          `${c.nameA} vs ${c.nameB} ` +
          `(n=${c.throughput.n})`,
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

        (doc as any).autoTable({
          startY: y,
          margin: {
            left: margin, right: margin,
          },
          head: [[
            'Metric', 't', 'p-value',
            'Effect', 'Winner',
          ]],
          body: cmpRows,
          theme: 'grid',
          styles: {
            fontSize: 7, cellPadding: 2,
          },
          headStyles: {
            fillColor: [248, 249, 250],
            textColor: [50, 50, 50],
            fontStyle: 'bold',
          },
        });
        y = (doc as any).lastAutoTable.finalY + 6;
      }
    }
  }

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

  const totalWallMs = entries.reduce(
    (acc, e) =>
      acc +
      (e.result.completedAt - e.result.startedAt),
    0,
  );
  const totalRuns = entries.reduce(
    (acc, e) =>
      acc +
      e.result.scenarios.length *
        (e.result.scenarios[0]?.aggregated.runs ??
          0),
    0,
  );

  const lines: string[] = [];

  lines.push(`# CRMQ Benchmark Report`);
  lines.push('');
  lines.push(
    `**Multi-Scenario Benchmark** — ` +
    `${entries.length} scenarios × ` +
    `${formulaNames.length} formulas — ` +
    `${totalRuns} total runs in ` +
    `${(totalWallMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  lines.push(
    `Exported: ${new Date().toISOString()}`,
  );
  lines.push('');

  // Overall winner
  lines.push(`## Overall Winner`);
  lines.push('');
  const bestWins =
    overallWins[bestFormulas[0]] ?? 0;
  if (bestFormulas.length > 1) {
    lines.push(
      `**Tied:** ${bestFormulas.join(', ')} ` +
      `— each won ${bestWins}/${totalContests} ` +
      `metric contests`,
    );
  } else {
    lines.push(
      `**${bestFormulas[0]}** — won ` +
      `${bestWins}/${totalContests} ` +
      `metric contests`,
    );
  }
  lines.push('');

  // Rankings
  lines.push(`## Formula Rankings`);
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

  // Winner Matrix
  lines.push(`## Winner Matrix`);
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

  // Per-scenario details
  for (const entry of entries) {
    const { result, preset } = entry;
    const scenarios = result.scenarios;
    const wc = preset.workloadConfig;

    lines.push(
      `## ${preset.name} (Phase ${preset.phase})`,
    );
    lines.push('');
    lines.push(`> ${preset.description}`);
    lines.push('');

    // Workload config
    lines.push(`### Workload Configuration`);
    lines.push('');
    lines.push(`| Parameter | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(
      `| Duration | ${fmtSec(wc.durationSeconds)} |`,
    );
    lines.push(
      `| Arrival | ` +
      `${describeArrival(wc.arrivalPattern)} |`,
    );
    if (wc.arrivalPattern.type !== 'periodic_mix') {
      lines.push(
        `| Size Dist. | ` +
        `${describeSize(wc.sizeDistribution)} |`,
      );
    }
    lines.push(`| Seed | ${wc.seed} |`);
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
          `| ${t.cpu} | ${t.memory} ` +
          `| ${t.gpu} ` +
          `| ${fmtSec(t.durationSeconds)} ` +
          `| every ${fmtSec(t.intervalSeconds)} ` +
          `| ${est} |`,
        );
      }
      lines.push('');
    }

    // Overview table
    lines.push(`### Overview Metrics`);
    lines.push('');
    const oHeader = scenarios
      .map((s) => s.scenarioName)
      .join(' | ');
    lines.push(`| Metric | ${oHeader} |`);
    lines.push(
      `| --- | ${scenarios.map(() => '---').join(' | ')} |`,
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
        label: "Jain's Fairness",
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

    // Per-scenario details
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
        `- Runs: ${a.runs} | ` +
        `Avg duration: ${fmtSec(avgDur)} | ` +
        `Avg warm-up: ${fmtSec(avgWarmUp)}`,
      );
      lines.push('');

      const poolTypes = Object.keys(a.utilization);
      if (poolTypes.length > 0) {
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
        lines.push(
          `| Org | Mean Wait | Jobs Completed |`,
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

    // Statistical comparisons
    if (result.comparisons.length > 0) {
      lines.push(`### Statistical Comparisons`);
      lines.push('');
      for (const c of result.comparisons) {
        lines.push(
          `**${c.nameA}** vs **${c.nameB}** ` +
          `(n=${c.throughput.n})`,
        );
        lines.push('');
        lines.push(
          '| Metric | t | p-value ' +
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
            label: "Jain's FI",
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
  }

  lines.push('---');
  lines.push(
    '*Generated by CRMQ Benchmark Simulator ' +
    '— Deep Origin*',
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
