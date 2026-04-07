/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Group, NumberInput, Stack, Text, UnstyledButton } from '@mantine/core';
import type { FormulaConfig, FormulaType } from '@/lib/config/types';
import { FORMULA_LIST } from '@/lib/config/formulas/registry';
import classes from './formula-step.module.css';

// ── Props ────────────────────────────────────────────────────────────────────

interface FormulaStepProps {
  formulaConfig: FormulaConfig;
  schedulerConfig: { topN: number; skipThreshold: number; backfillMaxRatio: number };
  ttlDefault: number;
  onSetFormulaType: (type: FormulaType) => void;
  onSetFormulaParam: (key: string, value: number | boolean | string) => void;
  onSetSchedulerParam: (key: 'topN' | 'skipThreshold' | 'backfillMaxRatio', value: number) => void;
  onSetTtlDefault: (value: number) => void;
}

// ── Formula Parameter Forms ──────────────────────────────────────────────────

const CurrentWeightedForm = ({
  params,
  onChange,
}: {
  params: { orgWeight: number; userWeight: number; toolWeight: number; agingFactor: number };
  onChange: (key: string, value: number) => void;
}) => (
  <Stack gap="sm" className={classes.paramForm}>
    <Text size="xs" fw={600} c="grey.7" tt="uppercase">
      Weight Parameters
    </Text>
    <Group gap="sm" grow>
      <NumberInput
        label="Org Weight"
        description="Priority multiplier for org tier"
        size="xs"
        value={params.orgWeight}
        onChange={(v) => onChange('orgWeight', Number(v))}
        min={0}
        max={100_000}
        step={1000}
      />
      <NumberInput
        label="User Weight"
        description="Priority multiplier for user"
        size="xs"
        value={params.userWeight}
        onChange={(v) => onChange('userWeight', Number(v))}
        min={0}
        max={100_000}
        step={100}
      />
    </Group>
    <Group gap="sm" grow>
      <NumberInput
        label="Tool Weight"
        description="Priority multiplier for tool"
        size="xs"
        value={params.toolWeight}
        onChange={(v) => onChange('toolWeight', Number(v))}
        min={0}
        max={100_000}
        step={10}
      />
      <NumberInput
        label="Aging Factor"
        description="Score pts/sec of wait time"
        size="xs"
        value={params.agingFactor}
        onChange={(v) => onChange('agingFactor', Number(v))}
        min={0}
        max={1000}
        step={1}
      />
    </Group>
  </Stack>
);

const NormalizedWeightedSumForm = ({
  params,
  onChange,
}: {
  params: { wTier: number; wAge: number; wUser: number; wTool: number; C: number; tau: number };
  onChange: (key: string, value: number) => void;
}) => (
  <Stack gap="sm" className={classes.paramForm}>
    <Text size="xs" fw={600} c="grey.7" tt="uppercase">
      Normalized Weights (should sum to 1.0)
    </Text>
    <Group gap="sm" grow>
      <NumberInput
        label="Tier Weight"
        description="Org priority factor"
        size="xs"
        value={params.wTier}
        onChange={(v) => onChange('wTier', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
      <NumberInput
        label="Age Weight"
        description="Wait time factor"
        size="xs"
        value={params.wAge}
        onChange={(v) => onChange('wAge', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
    </Group>
    <Group gap="sm" grow>
      <NumberInput
        label="User Weight"
        description="User priority factor"
        size="xs"
        value={params.wUser}
        onChange={(v) => onChange('wUser', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
      <NumberInput
        label="Tool Weight"
        description="Tool priority factor"
        size="xs"
        value={params.wTool}
        onChange={(v) => onChange('wTool', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
    </Group>
    <Text size="xs" fw={600} c="grey.7" tt="uppercase" mt="xs">
      Aging Parameters
    </Text>
    <Group gap="sm" grow>
      <NumberInput
        label="C (Aging Coefficient)"
        description="Controls aging curve steepness"
        size="xs"
        value={params.C}
        onChange={(v) => onChange('C', Number(v))}
        min={1}
        max={100}
        step={1}
      />
      <NumberInput
        label="τ (Time Constant)"
        description="Aging time constant in seconds"
        size="xs"
        value={params.tau}
        onChange={(v) => onChange('tau', Number(v))}
        min={1}
        max={3600}
        step={10}
      />
    </Group>
  </Stack>
);

const DrfFairShareForm = ({
  params,
  onChange,
}: {
  params: { C: number; tau: number };
  onChange: (key: string, value: number) => void;
}) => (
  <Stack gap="sm" className={classes.paramForm}>
    <Text size="xs" fw={600} c="grey.7" tt="uppercase">
      Aging Parameters
    </Text>
    <Group gap="sm" grow>
      <NumberInput
        label="C (Aging Coefficient)"
        description="Controls aging curve steepness"
        size="xs"
        value={params.C}
        onChange={(v) => onChange('C', Number(v))}
        min={1}
        max={100}
        step={1}
      />
      <NumberInput
        label="τ (Time Constant)"
        description="Aging time constant in seconds"
        size="xs"
        value={params.tau}
        onChange={(v) => onChange('tau', Number(v))}
        min={1}
        max={3600}
        step={10}
      />
    </Group>
  </Stack>
);

const BalancedCompositeForm = ({
  params,
  onChange,
}: {
  params: {
    wPriority: number; wAging: number;
    wLoad: number; wCpuHrs: number;
    agingHorizon: number; agingExponent: number;
    agingFloor: number; maxCpuHours: number;
  };
  onChange: (key: string, value: number) => void;
}) => (
  <Stack gap="sm" className={classes.paramForm}>
    <Text size="xs" fw={600} c="grey.7" tt="uppercase">
      Factor Weights (should sum to 1.0)
    </Text>
    <Group gap="sm" grow>
      <NumberInput
        label="Priority Weight"
        description="Org priority factor (0.35)"
        size="xs"
        value={params.wPriority}
        onChange={(v) => onChange('wPriority', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
      <NumberInput
        label="Aging Weight"
        description="Wait time factor (0.25)"
        size="xs"
        value={params.wAging}
        onChange={(v) => onChange('wAging', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
    </Group>
    <Group gap="sm" grow>
      <NumberInput
        label="Load Weight"
        description="Inverse org pool load (0.20)"
        size="xs"
        value={params.wLoad}
        onChange={(v) => onChange('wLoad', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
      <NumberInput
        label="CPU-Hrs Weight"
        description="Inverse log-normalized CPU-hours (0.20)"
        size="xs"
        value={params.wCpuHrs}
        onChange={(v) => onChange('wCpuHrs', Number(v))}
        min={0}
        max={1}
        step={0.05}
        decimalScale={2}
      />
    </Group>
    <Text size="xs" fw={600} c="grey.7" tt="uppercase" mt="xs">
      Aging Constants
    </Text>
    <Group gap="sm" grow>
      <NumberInput
        label="Aging Horizon"
        description="Full boost at this wait (seconds)"
        size="xs"
        value={params.agingHorizon}
        onChange={(v) => onChange('agingHorizon', Number(v))}
        min={60}
        max={86400}
        step={300}
      />
      <NumberInput
        label="Aging Exponent"
        description="Curve shape (2 = quadratic)"
        size="xs"
        value={params.agingExponent}
        onChange={(v) => onChange('agingExponent', Number(v))}
        min={1}
        max={5}
        step={0.5}
        decimalScale={1}
      />
    </Group>
    <Group gap="sm" grow>
      <NumberInput
        label="Aging Floor"
        description="Linear floor fraction (0.10 = 10%)"
        size="xs"
        value={params.agingFloor}
        onChange={(v) => onChange('agingFloor', Number(v))}
        min={0}
        max={0.5}
        step={0.05}
        decimalScale={2}
      />
      <NumberInput
        label="MAX_CPU_HOURS"
        description="Normalization ceiling for cpu_hours"
        size="xs"
        value={params.maxCpuHours}
        onChange={(v) => onChange('maxCpuHours', Number(v))}
        min={1}
        max={100000}
        step={100}
      />
    </Group>
  </Stack>
);

const NoParamsInfo = ({ message }: { message: string }) => (
  <Stack gap="sm" className={classes.paramForm}>
    <Text size="xs" c="dimmed" fs="italic">{message}</Text>
  </Stack>
);

// ── Main Component ───────────────────────────────────────────────────────────

export const FormulaStep = ({
  formulaConfig,
  schedulerConfig,
  ttlDefault,
  onSetFormulaType,
  onSetFormulaParam,
  onSetSchedulerParam,
  onSetTtlDefault,
}: FormulaStepProps) => {
  return (
    <Stack gap="lg" mt="md">
      {/* Formula Selection — Radio Cards */}
      <Box>
        <Text size="sm" fw={600} c="grey.8" mb="xs">
          Scheduling Formula
        </Text>
        <Stack gap={8}>
          {FORMULA_LIST.map((def) => {
            const isSelected = formulaConfig.type === def.id;
            return (
              <UnstyledButton
                key={def.id}
                onClick={() => onSetFormulaType(def.id)}
                className={`${classes.formulaCard} ${isSelected ? classes.formulaCardSelected : ''}`}
              >
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Text className={classes.formulaIcon}>{def.icon}</Text>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={6}>
                      <Text size="sm" fw={600}>{def.label}</Text>
                      <Box className={`${classes.radioIndicator} ${isSelected ? classes.radioIndicatorSelected : ''}`}>
                        {isSelected && <Box className={classes.radioInner} />}
                      </Box>
                    </Group>
                    <Text size="xs" c="dimmed" mt={2}>{def.description}</Text>
                    {isSelected && (
                      <Text size="xs" c="indigo.6" mt={4}>
                        Compatible limits: {def.compatibleLimitTypes.join(', ')}
                      </Text>
                    )}
                  </Box>
                </Group>
              </UnstyledButton>
            );
          })}
        </Stack>
      </Box>

      {/* Contextual Parameter Form — mounts based on selected formula */}
      <Box>
        {formulaConfig.type === 'current_weighted' && (
          <CurrentWeightedForm
            params={formulaConfig.params}
            onChange={(key, value) => onSetFormulaParam(key, value)}
          />
        )}
        {formulaConfig.type === 'normalized_weighted_sum' && (
          <NormalizedWeightedSumForm
            params={formulaConfig.params}
            onChange={(key, value) => onSetFormulaParam(key, value)}
          />
        )}
        {formulaConfig.type === 'drf_fair_share' && (
          <DrfFairShareForm
            params={formulaConfig.params}
            onChange={(key, value) => onSetFormulaParam(key, value)}
          />
        )}
        {formulaConfig.type === 'balanced_composite' && (
          <BalancedCompositeForm
            params={formulaConfig.params}
            onChange={(key, value) => onSetFormulaParam(key, value)}
          />
        )}
        {formulaConfig.type === 'strict_fifo' && (
          <NoParamsInfo message="Strict FIFO has no configurable parameters. Jobs are processed in arrival order." />
        )}
      </Box>

      {/* Scheduler Tuning */}
      <Box>
        <Text size="xs" fw={600} c="grey.7" tt="uppercase" mb="xs">
          Scheduler Tuning
        </Text>
        <Group gap="sm" grow>
          <NumberInput
            label="Top-N"
            description="Candidates evaluated per tick"
            size="xs"
            value={schedulerConfig.topN}
            onChange={(v) => onSetSchedulerParam('topN', Number(v))}
            min={1}
            max={100}
          />
          <NumberInput
            label="Skip Threshold"
            description="Skip count → reservation mode"
            size="xs"
            value={schedulerConfig.skipThreshold}
            onChange={(v) => onSetSchedulerParam('skipThreshold', Number(v))}
            min={1}
            max={50}
          />
          <NumberInput
            label="Backfill Max Ratio"
            description="Backfill duration ÷ blocked"
            size="xs"
            value={schedulerConfig.backfillMaxRatio}
            onChange={(v) => onSetSchedulerParam('backfillMaxRatio', Number(v))}
            min={0}
            max={10}
            step={0.1}
            decimalScale={1}
          />
        </Group>
      </Box>

    </Stack>
  );
};
