# CRMQ Virtual Cluster Simulator

An interactive browser-based simulator for the **Cost & Resource Management Queue (CRMQ)** priority scheduling system. It models how a cluster scheduler prioritizes and dispatches jobs based on organizational priorities, user priorities, tool priorities, and fair-share algorithms.

Everything runs client-side — no backend required.

## Features

- **Simulator** — Real-time cluster visualization with play/pause controls, adjustable speed, manual job submission, pool utilization monitoring, and virtual cluster predictions
- **Configuration** — Multi-step wizard to select scheduling formulas and set per-org resource quotas
- **Scenarios** — Predefined workload phases (MVP, Advanced, Edge Cases, Stress Tests, Realistic Workloads, Adversarial) with calibration rationale
- **Benchmarks** — Batch comparison of scheduling formulas across scenarios with configurable replications and chart visualizations
- **Reports** — Saved benchmark results and summaries

## Scheduling Formulas

The simulator supports multiple scheduling strategies:

- `current_weighted` — Weighted priority scoring
- `normalized_weighted_sum` — Normalized weighted sum
- `drf_fair_share` — Dominant Resource Fairness
- `balanced_composite` — Balanced composite scoring
- `strict_fifo` — First-in, first-out

## Tech Stack

- [Next.js](https://nextjs.org/) 14 (static export)
- [React](https://react.dev/) 18
- [Mantine](https://mantine.dev/) 8 (UI components)
- [Zustand](https://zustand.docs.pmnd.rs/) (state management)
- [Recharts](https://recharts.org/) (benchmark charts)
- [Zod](https://zod.dev/) (schema validation)
- TypeScript

## Getting Started

```bash
cd crmq-simulator
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build

```bash
npm run build
```

Static output is generated in `crmq-simulator/out/`, ready for deployment to any static host.

## Deployment

The project deploys automatically to GitHub Pages on push to `main` via the included workflow.

Live at: https://deeporiginbio.github.io/platform-crmq-simulator/
