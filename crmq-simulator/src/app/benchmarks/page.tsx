/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Button, Group, Stack, Text, Select, NumberInput, Progress, Checkbox, Tooltip, Table } from '@mantine/core';
import { useBenchmarkStore } from '@/lib/benchmark-store';
import { useConfigStore } from '@/lib/store';
import { SCENARIO_PRESETS, getFormulas } from '@/lib/benchmark';
import { BenchmarkResults } from '@/components/benchmark/benchmark-results';
import { ScenarioDetails } from '@/components/benchmark/scenario-details';

const BenchmarksPage = () => {
  const cfg = useConfigStore(s => s.cfg);
  const orgs = useConfigStore(s => s.orgs);

  const phase = useBenchmarkStore(s => s.phase);
  const scenarioId = useBenchmarkStore(s => s.scenarioId);
  const selectedFormulas = useBenchmarkStore(s => s.selectedFormulas);
  const replications = useBenchmarkStore(s => s.replications);
  const progress = useBenchmarkStore(s => s.progress);
  const progressLabel = useBenchmarkStore(s => s.progressLabel);
  const result = useBenchmarkStore(s => s.result);
  const error = useBenchmarkStore(s => s.error);

  const setScenario = useBenchmarkStore(s => s.setScenario);
  const toggleFormula = useBenchmarkStore(s => s.toggleFormula);
  const setReplications = useBenchmarkStore(s => s.setReplications);
  const run = useBenchmarkStore(s => s.run);
  const cancel = useBenchmarkStore(s => s.cancel);
  const reset = useBenchmarkStore(s => s.reset);

  const formulas = getFormulas();
  const selectedPreset = SCENARIO_PRESETS.find(s => s.id === scenarioId);

  const isRunning = phase === 'running';

  return (
    <Box p="md">
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between">
          <Box>
            <Text size="xl" fw={700} c="grey.9">Benchmarks</Text>
            <Text size="xs" c="dimmed" mt={2}>
              Compare scheduling formulas side-by-side with statistical rigor (Section 5)
            </Text>
          </Box>
          {result && (
            <Button variant="outline" color="grey" size="compact-sm" onClick={reset}>
              New Benchmark
            </Button>
          )}
        </Group>

        {/* Setup panel — show when not viewing results */}
        {phase !== 'done' && (
          <Box p="lg" style={{ background: '#fff', border: '1px solid #E5E7EA', borderRadius: 12 }}>
            <Stack gap="lg">
              <Text fw={600} c="grey.8" size="md">Benchmark Setup</Text>

              {/* Scenario selection */}
              <Box>
                <Text size="sm" fw={500} c="grey.7" mb={4}>Workload Scenario</Text>
                <Select
                  data={SCENARIO_PRESETS.map(p => ({
                    value: p.id,
                    label: p.name,
                  }))}
                  value={scenarioId}
                  onChange={(v) => v && setScenario(v)}
                  disabled={isRunning}
                  size="sm"
                  renderOption={({ option, checked }) => {
                    const preset = SCENARIO_PRESETS.find(p => p.id === option.value);
                    return (
                      <Box py={4}>
                        <Text size="xs" fw={checked ? 600 : 500}>{option.label}</Text>
                        {preset && (
                          <Text size="xs" c="dimmed" mt={2}>{preset.description}</Text>
                        )}
                      </Box>
                    );
                  }}
                />
                {selectedPreset && (
                  <Box mt="sm">
                    <ScenarioDetails preset={selectedPreset} />
                  </Box>
                )}
              </Box>

              {/* Formula selection */}
              <Box>
                <Text size="sm" fw={500} c="grey.7" mb={4}>
                  Formulas to Compare
                  <Text span c="dimmed" size="xs" ml={8}>(select 2+ for paired comparison)</Text>
                </Text>
                <Stack gap={6}>
                  {formulas.map(f => (
                    <Group key={f.id} gap="sm" wrap="nowrap">
                      <Checkbox
                        size="xs"
                        checked={selectedFormulas.includes(f.id)}
                        onChange={() => toggleFormula(f.id)}
                        disabled={isRunning}
                        label={
                          <Box>
                            <Text size="xs" fw={500}>{f.name}</Text>
                            <Text size="xs" c="dimmed">{f.description}</Text>
                          </Box>
                        }
                      />
                    </Group>
                  ))}
                </Stack>
              </Box>

              {/* Replications */}
              <Box>
                <Group gap="sm" align="flex-end">
                  <NumberInput
                    label="Replications per scenario"
                    description="Min 30 for CLT (Section 5.5)"
                    value={replications}
                    onChange={(v) => typeof v === 'number' && setReplications(v)}
                    min={1}
                    max={200}
                    step={10}
                    size="sm"
                    w={200}
                    disabled={isRunning}
                  />
                  <Group gap={4}>
                    {[5, 30, 50, 100].map(n => (
                      <Button
                        key={n}
                        variant={replications === n ? 'filled' : 'outline'}
                        color="grey"
                        size="compact-xs"
                        onClick={() => setReplications(n)}
                        disabled={isRunning}
                      >
                        {n}
                      </Button>
                    ))}
                  </Group>
                </Group>
              </Box>

              {/* Run summary + button */}
              <Box
                p="sm"
                style={{ background: '#F9FAFB', borderRadius: 8, border: '1px solid #E5E7EA' }}
              >
                <Group justify="space-between" align="center">
                  <Box>
                    <Text size="xs" c="grey.6">
                      Will run: <Text span fw={600}>{selectedFormulas.length}</Text> formulas ×{' '}
                      <Text span fw={600}>{replications}</Text> replications ={' '}
                      <Text span fw={700} c="indigo.5">{selectedFormulas.length * replications}</Text> total DES runs
                    </Text>
                    <Text size="xs" c="dimmed" mt={2}>
                      Using current cluster config ({cfg.cluster.pools.map(p => p.shortLabel).join(' + ')}) with {orgs.length} org{orgs.length !== 1 ? 's' : ''}
                    </Text>
                  </Box>
                  <Button
                    color="indigo"
                    size="sm"
                    onClick={() => run(cfg, orgs)}
                    disabled={isRunning || selectedFormulas.length === 0}
                    loading={isRunning}
                  >
                    {isRunning ? 'Running...' : 'Run Benchmark'}
                  </Button>
                </Group>
              </Box>

              {/* Progress bar + cancel */}
              {isRunning && (
                <Box>
                  <Progress value={progress} size="lg" radius="md" color="indigo" animated striped />
                  <Group justify="space-between" mt={4}>
                    <Text size="xs" c="dimmed">{progressLabel}</Text>
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
                <Box p="sm" style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8 }}>
                  <Text size="sm" c="red.7" fw={500}>{error}</Text>
                </Box>
              )}
            </Stack>
          </Box>
        )}

        {/* Results — rendered by child component */}
        {phase === 'done' && result && <BenchmarkResults result={result} scenarioPreset={selectedPreset} />}
      </Stack>
    </Box>
  );
};

export default BenchmarksPage;
