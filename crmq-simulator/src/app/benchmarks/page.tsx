/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import {
  Badge,
  Box,
  Button,
  Checkbox,
  Collapse,
  Group,
  NumberInput,
  Progress,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useState } from 'react';
import { useBenchmarkStore } from '@/lib/benchmark-store';
import { useConfigStore } from '@/lib/store';
import {
  SCENARIO_PRESETS,
  getFormulas,
} from '@/lib/benchmark';
import type { ScenarioPreset } from '@/lib/benchmark';
import { BenchmarkResults } from
  '@/components/benchmark/benchmark-results';
import { MultiScenarioResults } from
  '@/components/benchmark/multi-scenario-results';
import { ScenarioDetails } from
  '@/components/benchmark/scenario-details';

// ── Phase badge helpers ──────────────────────────────────────────

const phaseMeta: Record<
  number,
  { label: string; color: string }
> = {
  1: { label: 'Core', color: 'blue' },
  2: { label: 'Advanced', color: 'violet' },
  4: { label: 'Stress', color: 'red' },
  5: { label: 'Realistic', color: 'teal' },
  6: { label: 'Adversarial', color: 'pink' },
};

// Group presets by phase
const groupedPresets = SCENARIO_PRESETS.reduce(
  (acc, p) => {
    if (!acc[p.phase]) acc[p.phase] = [];
    acc[p.phase].push(p);
    return acc;
  },
  {} as Record<number, ScenarioPreset[]>,
);

const BenchmarksPage = () => {
  const cfg = useConfigStore((s) => s.cfg);
  const orgs = useConfigStore((s) => s.orgs);

  const phase = useBenchmarkStore((s) => s.phase);
  const selectedScenarioIds = useBenchmarkStore(
    (s) => s.selectedScenarioIds,
  );
  const selectedFormulas = useBenchmarkStore(
    (s) => s.selectedFormulas,
  );
  const replications = useBenchmarkStore(
    (s) => s.replications,
  );
  const progress = useBenchmarkStore(
    (s) => s.progress,
  );
  const progressLabel = useBenchmarkStore(
    (s) => s.progressLabel,
  );
  const result = useBenchmarkStore((s) => s.result);
  const multiResults = useBenchmarkStore(
    (s) => s.multiResults,
  );
  const error = useBenchmarkStore((s) => s.error);

  const toggleScenario = useBenchmarkStore(
    (s) => s.toggleScenario,
  );
  const selectAllScenarios = useBenchmarkStore(
    (s) => s.selectAllScenarios,
  );
  const clearAllScenarios = useBenchmarkStore(
    (s) => s.clearAllScenarios,
  );
  const toggleFormula = useBenchmarkStore(
    (s) => s.toggleFormula,
  );
  const selectAllFormulas = useBenchmarkStore(
    (s) => s.selectAllFormulas,
  );
  const setReplications = useBenchmarkStore(
    (s) => s.setReplications,
  );
  const run = useBenchmarkStore((s) => s.run);
  const cancel = useBenchmarkStore((s) => s.cancel);
  const reset = useBenchmarkStore((s) => s.reset);

  const formulas = getFormulas();
  const isRunning = phase === 'running';
  const isMulti = multiResults.length > 1;

  // Expandable scenario details
  const [expandedScenario, setExpandedScenario] =
    useState<string | null>(null);

  // All selected / some selected for bulk toggles
  const allScenariosSelected =
    selectedScenarioIds.length ===
    SCENARIO_PRESETS.length;
  const allFormulasSelected =
    selectedFormulas.length === formulas.length;

  const totalRuns =
    selectedScenarioIds.length *
    selectedFormulas.length *
    replications;

  return (
    <Box p="md">
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between">
          <Box>
            <Text size="xl" fw={700} c="grey.9">
              Benchmarks
            </Text>
            <Text size="xs" c="dimmed" mt={2}>
              Compare scheduling formulas across
              multiple workload scenarios
            </Text>
          </Box>
          {(result || multiResults.length > 0) && (
            <Button
              variant="outline"
              color="grey"
              size="compact-sm"
              onClick={reset}
            >
              New Benchmark
            </Button>
          )}
        </Group>

        {/* Setup panel */}
        {phase !== 'done' && (
          <Box
            p="lg"
            style={{
              background: '#fff',
              border: '1px solid #E5E7EA',
              borderRadius: 12,
            }}
          >
            <Stack gap="lg">
              <Text fw={600} c="grey.8" size="md">
                Benchmark Setup
              </Text>

              {/* ── Scenario Selection ──────────── */}
              <Box>
                <Group
                  justify="space-between"
                  mb={8}
                >
                  <Text
                    size="sm"
                    fw={500}
                    c="grey.7"
                  >
                    Workload Scenarios
                    <Text
                      span
                      c="dimmed"
                      size="xs"
                      ml={8}
                    >
                      ({selectedScenarioIds.length}{' '}
                      selected)
                    </Text>
                  </Text>
                  <Group gap={4}>
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      onClick={selectAllScenarios}
                      disabled={
                        isRunning ||
                        allScenariosSelected
                      }
                    >
                      Select All
                    </Button>
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      color="grey"
                      onClick={clearAllScenarios}
                      disabled={isRunning}
                    >
                      Reset
                    </Button>
                  </Group>
                </Group>

                <Stack gap={4}>
                  {Object.entries(groupedPresets)
                    .sort(
                      ([a], [b]) =>
                        Number(a) - Number(b),
                    )
                    .map(
                      ([phaseNum, presets]) => {
                        const pm =
                          phaseMeta[
                            Number(phaseNum)
                          ] ?? {
                            label: `Phase ${phaseNum}`,
                            color: 'grey',
                          };
                        // How many from this phase are selected?
                        const selectedCount =
                          presets.filter((p) =>
                            selectedScenarioIds.includes(
                              p.id,
                            ),
                          ).length;
                        const allPhaseSelected =
                          selectedCount ===
                          presets.length;

                        return (
                          <Box
                            key={phaseNum}
                            p="xs"
                            style={{
                              border:
                                '1px solid #F1F3F5',
                              borderRadius: 8,
                            }}
                          >
                            <Group
                              gap="xs"
                              mb={4}
                            >
                              <Badge
                                size="xs"
                                variant="light"
                                color={pm.color}
                              >
                                {pm.label}
                              </Badge>
                              <Text
                                size="xs"
                                c="dimmed"
                              >
                                {selectedCount}/
                                {presets.length}
                              </Text>
                              <Button
                                variant="subtle"
                                size="compact-xs"
                                onClick={() => {
                                  const ids =
                                    presets.map(
                                      (p) => p.id,
                                    );
                                  if (
                                    allPhaseSelected
                                  ) {
                                    // Deselect all in this phase (keep ≥1 overall)
                                    const remaining =
                                      selectedScenarioIds.filter(
                                        (id) =>
                                          !ids.includes(
                                            id,
                                          ),
                                      );
                                    if (
                                      remaining.length >
                                      0
                                    ) {
                                      useBenchmarkStore
                                        .getState()
                                        .setSelectedScenarios(
                                          remaining,
                                        );
                                    }
                                  } else {
                                    // Select all in this phase
                                    const merged =
                                      Array.from(
                                        new Set(
                                          selectedScenarioIds.concat(
                                            ids,
                                          ),
                                        ),
                                      );
                                    useBenchmarkStore
                                      .getState()
                                      .setSelectedScenarios(
                                        merged,
                                      );
                                  }
                                }}
                                disabled={
                                  isRunning
                                }
                              >
                                {allPhaseSelected
                                  ? 'Deselect phase'
                                  : 'Select phase'}
                              </Button>
                            </Group>
                            <Stack gap={2}>
                              {presets.map((p) => {
                                const checked =
                                  selectedScenarioIds.includes(
                                    p.id,
                                  );
                                const isExpanded =
                                  expandedScenario ===
                                  p.id;
                                return (
                                  <Box key={p.id}>
                                    <Group
                                      gap="xs"
                                      wrap="nowrap"
                                      align="flex-start"
                                    >
                                      <Checkbox
                                        size="xs"
                                        checked={
                                          checked
                                        }
                                        onChange={() =>
                                          toggleScenario(
                                            p.id,
                                          )
                                        }
                                        disabled={
                                          isRunning
                                        }
                                        mt={2}
                                      />
                                      <Box
                                        style={{
                                          flex: 1,
                                          cursor:
                                            'pointer',
                                        }}
                                        onClick={() =>
                                          setExpandedScenario(
                                            isExpanded
                                              ? null
                                              : p.id,
                                          )
                                        }
                                      >
                                        <Group
                                          gap={4}
                                        >
                                          <Text
                                            size="xs"
                                            fw={500}
                                          >
                                            {p.name}
                                          </Text>
                                          <Text
                                            size="xs"
                                            c="dimmed"
                                          >
                                            —{' '}
                                            {
                                              p.description
                                            }
                                          </Text>
                                        </Group>
                                      </Box>
                                    </Group>
                                    <Collapse
                                      in={
                                        isExpanded
                                      }
                                    >
                                      <Box
                                        ml={28}
                                        mt={4}
                                        mb={4}
                                      >
                                        <ScenarioDetails
                                          preset={
                                            p
                                          }
                                          compact
                                        />
                                      </Box>
                                    </Collapse>
                                  </Box>
                                );
                              })}
                            </Stack>
                          </Box>
                        );
                      },
                    )}
                </Stack>
              </Box>

              {/* ── Formula Selection ───────────── */}
              <Box>
                <Group
                  justify="space-between"
                  mb={4}
                >
                  <Text
                    size="sm"
                    fw={500}
                    c="grey.7"
                  >
                    Formulas to Compare
                    <Text
                      span
                      c="dimmed"
                      size="xs"
                      ml={8}
                    >
                      ({selectedFormulas.length}{' '}
                      selected)
                    </Text>
                  </Text>
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    onClick={selectAllFormulas}
                    disabled={
                      isRunning ||
                      allFormulasSelected
                    }
                  >
                    Select All
                  </Button>
                </Group>
                <Stack gap={6}>
                  {formulas.map((f) => (
                    <Group
                      key={f.id}
                      gap="sm"
                      wrap="nowrap"
                    >
                      <Checkbox
                        size="xs"
                        checked={selectedFormulas.includes(
                          f.id,
                        )}
                        onChange={() =>
                          toggleFormula(f.id)
                        }
                        disabled={isRunning}
                        label={
                          <Box>
                            <Text
                              size="xs"
                              fw={500}
                            >
                              {f.name}
                            </Text>
                            <Text
                              size="xs"
                              c="dimmed"
                            >
                              {f.description}
                            </Text>
                          </Box>
                        }
                      />
                    </Group>
                  ))}
                </Stack>
              </Box>

              {/* ── Replications ────────────────── */}
              <Box>
                <Group gap="sm" align="flex-end">
                  <NumberInput
                    label="Replications per formula"
                    description={
                      'Min 30 for CLT (Section 5.5)'
                    }
                    value={replications}
                    onChange={(v) =>
                      typeof v === 'number' &&
                      setReplications(v)
                    }
                    min={1}
                    max={200}
                    step={10}
                    size="sm"
                    w={200}
                    disabled={isRunning}
                  />
                  <Group gap={4}>
                    {[5, 30, 50, 100].map((n) => (
                      <Button
                        key={n}
                        variant={
                          replications === n
                            ? 'filled'
                            : 'outline'
                        }
                        color="grey"
                        size="compact-xs"
                        onClick={() =>
                          setReplications(n)
                        }
                        disabled={isRunning}
                      >
                        {n}
                      </Button>
                    ))}
                  </Group>
                </Group>
              </Box>

              {/* ── Run Summary + Button ────────── */}
              <Box
                p="sm"
                style={{
                  background: '#F9FAFB',
                  borderRadius: 8,
                  border: '1px solid #E5E7EA',
                }}
              >
                <Group
                  justify="space-between"
                  align="center"
                >
                  <Box>
                    <Text size="xs" c="grey.6">
                      Will run:{' '}
                      <Text span fw={600}>
                        {
                          selectedScenarioIds.length
                        }
                      </Text>{' '}
                      scenario
                      {selectedScenarioIds.length !==
                      1
                        ? 's'
                        : ''}{' '}
                      ×{' '}
                      <Text span fw={600}>
                        {selectedFormulas.length}
                      </Text>{' '}
                      formulas ×{' '}
                      <Text span fw={600}>
                        {replications}
                      </Text>{' '}
                      runs ={' '}
                      <Text
                        span
                        fw={700}
                        c="indigo.5"
                      >
                        {totalRuns}
                      </Text>{' '}
                      total DES runs
                    </Text>
                    <Text
                      size="xs"
                      c="dimmed"
                      mt={2}
                    >
                      Using current cluster config (
                      {cfg.cluster.pools
                        .map((p) => p.shortLabel)
                        .join(' + ')}
                      ) with {orgs.length} org
                      {orgs.length !== 1 ? 's' : ''}
                      {selectedScenarioIds.length >
                        1 &&
                        ' — sequential execution'}
                    </Text>
                  </Box>
                  <Button
                    color="indigo"
                    size="sm"
                    onClick={() => run(cfg, orgs)}
                    disabled={
                      isRunning ||
                      selectedFormulas.length ===
                        0 ||
                      selectedScenarioIds.length ===
                        0
                    }
                    loading={isRunning}
                  >
                    {isRunning
                      ? 'Running...'
                      : 'Run Benchmark'}
                  </Button>
                </Group>
              </Box>

              {/* ── Progress bar + cancel ───────── */}
              {isRunning && (
                <Box>
                  <Progress
                    value={progress}
                    size="lg"
                    radius="md"
                    color="indigo"
                    animated
                    striped
                  />
                  <Group
                    justify="space-between"
                    mt={4}
                  >
                    <Text size="xs" c="dimmed">
                      {progressLabel}
                    </Text>
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-xs"
                      onClick={cancel}
                    >
                      Cancel
                    </Button>
                  </Group>
                </Box>
              )}

              {/* Error */}
              {error && (
                <Box
                  p="sm"
                  style={{
                    background: '#FEF2F2',
                    border: '1px solid #FECACA',
                    borderRadius: 8,
                  }}
                >
                  <Text size="sm" c="red.7" fw={500}>
                    {error}
                  </Text>
                </Box>
              )}
            </Stack>
          </Box>
        )}

        {/* ── Results ──────────────────────────── */}
        {phase === 'done' && isMulti && (
          <MultiScenarioResults
            entries={multiResults}
          />
        )}
        {phase === 'done' &&
          !isMulti &&
          multiResults.length === 1 && (
            <BenchmarkResults
              result={multiResults[0].result}
              scenarioPreset={
                multiResults[0].preset
              }
            />
          )}
      </Stack>
    </Box>
  );
};

export default BenchmarksPage;
