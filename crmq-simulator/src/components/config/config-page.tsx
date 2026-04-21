/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState, useMemo } from 'react';
import { Box, Button, Group, Stack, Stepper, Text, Alert } from '@mantine/core';
import type { CRMQConfig, Org } from '@/lib/types';
import { useConfigForm, buildInitialConfig } from '@/lib/config';
import { useConfigValidation } from '@/lib/config/use-config-validation';
import { FormulaStep } from './formula-step';
import { OrgQuotasStep } from './org-quotas-step';
import { ReviewStep } from './review-step';
import classes from './config-page.module.css';

interface ConfigPageProps {
  config: CRMQConfig;
  orgs: Org[];
  onApply: (config: CRMQConfig, orgs: Org[]) => void;
  onCancel: () => void;
}

const STEPS = [
  { label: 'Scheduling Formula', description: 'Choose how jobs are scored and ordered' },
  { label: 'Org Quotas', description: 'Set per-org resource limits per pool' },
  { label: 'Review & Apply', description: 'Verify configuration and apply changes' },
] as const;

export const ConfigPage = ({ config, orgs, onApply, onCancel }: ConfigPageProps) => {
  const [activeStep, setActiveStep] = useState(0);

  const initialConfig = useMemo(() => buildInitialConfig(config, orgs), [config, orgs]);
  const form = useConfigForm(initialConfig);
  const { errors, warnings, hasErrors } = useConfigValidation(form.state);

  const nextStep = () => setActiveStep((s) => Math.min(s + 1, STEPS.length - 1));
  const prevStep = () => setActiveStep((s) => Math.max(s - 1, 0));

  const handleApply = () => {
    if (hasErrors) return;

    // Convert SchedulingPolicyConfig back to CRMQConfig + Org[]
    const newConfig: CRMQConfig = {
      scoring: form.state.formula.type === 'current_weighted'
        ? (form.state.formula.params as CRMQConfig['scoring'])
        : config.scoring,
      scheduler: { ...form.state.scheduler },
      cluster: { pools: form.state.cluster.pools },
      ttlDefault: form.state.ttlDefault,
      formulaType: form.state.formula.type,
      formulaParams: form.state.formula.params as unknown as Record<string, unknown>,
    };

    // Update org limits from the quota config — percent-only, clamped [0, 100]
    const newOrgs = orgs.map((org) => {
      const oq = form.state.orgQuotas.find((q) => q.orgId === org.id);
      if (!oq) return org;

      const limits: Record<string, number> = {};
      for (const pool of form.state.cluster.pools) {
        const pct = oq.limits[pool.type];
        if (typeof pct === 'number') {
          limits[pool.type] = Math.max(0, Math.min(100, pct));
        }
      }

      return { ...org, limits };
    });

    onApply(newConfig, newOrgs);
  };

  return (
    <Box className={classes.wrapper}>
      <Stack gap="lg">
        {/* Header */}
        <Group justify="space-between" align="flex-start">
          <Box>
            <Text size="xl" fw={700} c="grey.9">Scheduling Policy</Text>
            <Text size="xs" c="dimmed" mt={2}>
              Configure how CRMQ scores, orders, and limits workloads
            </Text>
          </Box>
          <Group gap="xs">
            <Button variant="subtle" color="grey" size="compact-sm" onClick={onCancel}>
              Cancel
            </Button>
          </Group>
        </Group>

        {/* Stepper */}
        <Stepper
          active={activeStep}
          onStepClick={setActiveStep}
          size="sm"
          color="indigo"
          classNames={{
            root: classes.stepper,
            step: classes.step,
            stepLabel: classes.stepLabel,
            stepDescription: classes.stepDescription,
          }}
        >
          <Stepper.Step label={STEPS[0].label} description={STEPS[0].description}>
            <FormulaStep
              formulaConfig={form.state.formula}
              schedulerConfig={form.state.scheduler}
              ttlDefault={form.state.ttlDefault}
              onSetFormulaType={form.setFormulaType}
              onSetFormulaParam={form.setFormulaParam}
              onSetSchedulerParam={form.setSchedulerParam}
              onSetTtlDefault={form.setTtlDefault}
            />
          </Stepper.Step>

          <Stepper.Step label={STEPS[1].label} description={STEPS[1].description}>
            <OrgQuotasStep
              orgQuotas={form.state.orgQuotas}
              pools={form.state.cluster.pools}
              orgs={orgs}
              onSetLimitPctQuota={form.setLimitPctQuota}
            />
          </Stepper.Step>

          <Stepper.Step label={STEPS[2].label} description={STEPS[2].description}>
            <ReviewStep
              config={form.state}
              orgs={orgs}
              errors={errors}
              warnings={warnings}
            />
          </Stepper.Step>
        </Stepper>

        {/* Validation alerts */}
        {hasErrors && activeStep === STEPS.length - 1 && (
          <Alert color="red" variant="light" title="Configuration errors">
            <Stack gap={4}>
              {errors.map((e, i) => (
                <Text key={i} size="xs">{e.message}</Text>
              ))}
            </Stack>
          </Alert>
        )}

        {/* Navigation */}
        <Group justify="space-between" className={classes.footer}>
          <Button
            variant="default"
            size="compact-sm"
            onClick={prevStep}
            disabled={activeStep === 0}
          >
            Back
          </Button>
          <Group gap="xs">
            {activeStep < STEPS.length - 1 ? (
              <Button color="indigo" size="compact-sm" onClick={nextStep}>
                Continue
              </Button>
            ) : (
              <Button
                color="green"
                size="compact-sm"
                onClick={handleApply}
                disabled={hasErrors}
              >
                Apply Configuration
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Box>
  );
};
