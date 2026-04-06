/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState, useMemo } from 'react';
import { Badge, Box, Group, NumberInput, Stack, Text, UnstyledButton } from '@mantine/core';
import type { Resources, Org, QuotaType } from '@/lib/types';
import type { FormulaType, LimitMode, LimitValue, OrgQuotaConfig } from '@/lib/config/types';
import { MEMORY_PER_CPU, CPU_PER_GPU, getUserValue, getQuotaLabel, deriveResources } from '@/lib/config/types';
import { getFormula } from '@/lib/config/formulas/registry';
import { LIMIT_LIST } from '@/lib/config/limits/registry';
import classes from './org-quotas-step.module.css';

// ── Props ────────────────────────────────────────────────────────────────────

interface OrgQuotasStepProps {
  orgQuotas: OrgQuotaConfig[];
  pools: Array<{ type: string; label: string; shortLabel: string; color: string; quotaType: QuotaType; total: Resources }>;
  orgs: Org[];
  formulaType: FormulaType;
  onSetLimitMode: (orgId: string, poolType: string, mode: LimitMode) => void;
  onSetLimitQuota: (orgId: string, poolType: string, quotaType: QuotaType, value: number) => void;
  onSetLimitPctQuota: (orgId: string, poolType: string, pctValue: number) => void;
}

// ── Limit Mode Pill Group ────────────────────────────────────────────────────

const LimitModePills = ({
  currentMode,
  compatibleModes,
  onChange,
}: {
  currentMode: LimitMode;
  compatibleModes: Set<LimitMode>;
  onChange: (mode: LimitMode) => void;
}) => (
  <Group gap={4}>
    {LIMIT_LIST.map((def) => {
      const isActive = currentMode === def.mode;
      const isCompatible = compatibleModes.has(def.mode);
      return (
        <UnstyledButton
          key={def.mode}
          onClick={() => isCompatible && onChange(def.mode)}
          disabled={!isCompatible}
          className={`${classes.pill} ${isActive ? classes.pillActive : ''} ${!isCompatible ? classes.pillDisabled : ''}`}
        >
          <Text size="xs" span>{def.icon}</Text>
          <Text size="xs" fw={isActive ? 600 : 400}>{def.label}</Text>
        </UnstyledButton>
      );
    })}
  </Group>
);

// ── Derived Resources Preview ────────────────────────────────────────────────

const DerivedPreview = ({ quotaType, resources }: { quotaType: QuotaType; resources: Resources }) => {
  if (quotaType === 'gpu') {
    return (
      <Group gap="sm">
        <Text size="xs" c="dimmed">Derived:</Text>
        <Badge size="sm" variant="light" color="grey" radius="sm">CPU: {resources.cpu}</Badge>
        <Badge size="sm" variant="light" color="grey" radius="sm">Mem: {resources.memory} GB</Badge>
      </Group>
    );
  }
  // cpu pool — no GPU, show only memory
  return (
    <Group gap="sm">
      <Text size="xs" c="dimmed">Derived:</Text>
      <Badge size="sm" variant="light" color="grey" radius="sm">Mem: {resources.memory} GB</Badge>
    </Group>
  );
};

// ── Limit Value Forms ────────────────────────────────────────────────────────

const AbsoluteLimitForm = ({
  resources,
  poolTotal,
  quotaType,
  onSetQuota,
}: {
  resources: Resources;
  poolTotal: Resources;
  quotaType: QuotaType;
  onSetQuota: (value: number) => void;
}) => {
  const label = getQuotaLabel(quotaType);
  const currentValue = getUserValue(quotaType, resources);
  const maxValue = getUserValue(quotaType, poolTotal);
  const derived = deriveResources(quotaType, currentValue);

  return (
    <Stack gap={8}>
      <NumberInput
        label={`${label} Limit`}
        description={`of ${maxValue} total`}
        size="xs"
        value={currentValue}
        onChange={(v) => onSetQuota(Number(v))}
        min={0}
        max={maxValue}
        w={180}
      />
      <DerivedPreview quotaType={quotaType} resources={derived} />
    </Stack>
  );
};

const PercentageLimitForm = ({
  pct,
  poolTotal,
  quotaType,
  onSetPctQuota,
}: {
  pct: Resources;
  poolTotal: Resources;
  quotaType: QuotaType;
  onSetPctQuota: (pctValue: number) => void;
}) => {
  const label = getQuotaLabel(quotaType);
  const currentPct = quotaType === 'gpu' ? pct.gpu : pct.cpu;
  const primaryTotal = getUserValue(quotaType, poolTotal);
  const resolvedPrimary = Math.round(primaryTotal * currentPct / 100);
  const derived = deriveResources(quotaType, resolvedPrimary);

  return (
    <Stack gap={8}>
      <NumberInput
        label={`${label} %`}
        size="xs"
        value={currentPct}
        onChange={(v) => onSetPctQuota(Number(v))}
        min={0}
        max={200}
        suffix="%"
        w={180}
      />
      <Group gap="sm">
        <Text size="xs" c="dimmed">Resolves to:</Text>
        <Badge size="sm" variant="light" color="indigo" radius="sm">
          {label}: {resolvedPrimary}
        </Badge>
      </Group>
      <DerivedPreview quotaType={quotaType} resources={derived} />
    </Stack>
  );
};

const UncappedBadge = () => (
  <Group gap="xs">
    <Badge size="lg" variant="light" color="green" radius="sm" leftSection="∞">
      No limit — org can use full pool capacity
    </Badge>
  </Group>
);

// ── Pool Limit Card ──────────────────────────────────────────────────────────

const PoolLimitCard = ({
  poolLabel,
  poolColor,
  poolTotal,
  quotaType,
  limit,
  compatibleModes,
  onSetMode,
  onSetQuota,
  onSetPctQuota,
}: {
  poolLabel: string;
  poolColor: string;
  poolTotal: Resources;
  quotaType: QuotaType;
  limit: LimitValue;
  compatibleModes: Set<LimitMode>;
  onSetMode: (mode: LimitMode) => void;
  onSetQuota: (value: number) => void;
  onSetPctQuota: (pctValue: number) => void;
}) => (
  <Box className={classes.poolCard}>
    <Group justify="space-between" mb="xs">
      <Group gap={6}>
        <Box className={classes.poolDot} style={{ background: poolColor }} />
        <Text size="xs" fw={600}>{poolLabel}</Text>
        <Badge size="xs" variant="outline" color="grey" radius="sm">
          {quotaType === 'gpu' ? 'GPU pool' : 'CPU pool'}
        </Badge>
      </Group>
      <LimitModePills
        currentMode={limit.mode}
        compatibleModes={compatibleModes}
        onChange={onSetMode}
      />
    </Group>

    {limit.mode === 'absolute' && (
      <AbsoluteLimitForm
        resources={limit.resources}
        poolTotal={poolTotal}
        quotaType={quotaType}
        onSetQuota={onSetQuota}
      />
    )}
    {limit.mode === 'percentage' && (
      <PercentageLimitForm
        pct={limit.pct}
        poolTotal={poolTotal}
        quotaType={quotaType}
        onSetPctQuota={onSetPctQuota}
      />
    )}
    {limit.mode === 'uncapped' && <UncappedBadge />}
  </Box>
);

// ── Org Quota Card ───────────────────────────────────────────────────────────

const OrgQuotaCard = ({
  orgQuota,
  orgName,
  orgPriority,
  pools,
  compatibleModes,
  onSetLimitMode,
  onSetQuota,
  onSetPctQuota,
}: {
  orgQuota: OrgQuotaConfig;
  orgName: string;
  orgPriority: number;
  pools: OrgQuotasStepProps['pools'];
  compatibleModes: Set<LimitMode>;
  onSetLimitMode: (poolType: string, mode: LimitMode) => void;
  onSetQuota: (poolType: string, quotaType: QuotaType, value: number) => void;
  onSetPctQuota: (poolType: string, pctValue: number) => void;
}) => {
  const [expanded, setExpanded] = useState(true);

  return (
    <Box className={classes.orgCard}>
      <UnstyledButton onClick={() => setExpanded((e) => !e)} className={classes.orgHeader}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" className={classes.chevron}>
            {expanded ? '▾' : '▸'}
          </Text>
          <Text size="sm" fw={600}>{orgName}</Text>
          <Badge size="xs" variant="light" color="violet" radius="sm">P{orgPriority}</Badge>
        </Group>
        {!expanded && (
          <Text size="xs" c="dimmed" ff="monospace">
            {pools.map(p => {
              const lim = orgQuota.limits[p.type];
              const label = getQuotaLabel(p.quotaType);
              if (!lim) return `${p.shortLabel}: ?`;
              if (lim.mode === 'uncapped') return `${p.shortLabel}: ∞`;
              if (lim.mode === 'percentage') return `${p.shortLabel}: ${p.quotaType === 'gpu' ? lim.pct.gpu : lim.pct.cpu}% ${label}`;
              return `${p.shortLabel}: ${getUserValue(p.quotaType, lim.resources)} ${label}`;
            }).join(' · ')}
          </Text>
        )}
      </UnstyledButton>

      {expanded && (
        <Stack gap="sm" mt="sm">
          {pools.map((pool) => {
            const limit = orgQuota.limits[pool.type];
            if (!limit) return null;

            return (
              <PoolLimitCard
                key={pool.type}
                poolLabel={pool.label}
                poolColor={pool.color}
                poolTotal={pool.total}
                quotaType={pool.quotaType}
                limit={limit}
                compatibleModes={compatibleModes}
                onSetMode={(mode) => onSetLimitMode(pool.type, mode)}
                onSetQuota={(value) => onSetQuota(pool.type, pool.quotaType, value)}
                onSetPctQuota={(pctValue) => onSetPctQuota(pool.type, pctValue)}
              />
            );
          })}
        </Stack>
      )}
    </Box>
  );
};

// ── Main Component ───────────────────────────────────────────────────────────

export const OrgQuotasStep = ({
  orgQuotas,
  pools,
  orgs,
  formulaType,
  onSetLimitMode,
  onSetLimitQuota,
  onSetLimitPctQuota,
}: OrgQuotasStepProps) => {
  const formulaDef = useMemo(() => getFormula(formulaType), [formulaType]);
  const compatibleModes = useMemo(
    () => new Set(formulaDef.compatibleLimitTypes),
    [formulaDef],
  );

  return (
    <Stack gap="md" mt="md">
      <Box>
        <Text size="sm" fw={600} c="grey.8">
          Per-Organization Resource Limits
        </Text>
        <Text size="xs" c="dimmed" mt={2}>
          Configure the primary resource per pool. CPU pools: set CPU (memory derived at {MEMORY_PER_CPU} GB/CPU).
          GPU pools: set GPU (CPU derived at {CPU_PER_GPU} CPU/GPU, memory derived).
        </Text>
      </Box>

      <Stack gap="sm">
        {orgQuotas.map((oq) => {
          const org = orgs.find(o => o.id === oq.orgId);
          return (
            <OrgQuotaCard
              key={oq.orgId}
              orgQuota={oq}
              orgName={org?.name ?? oq.orgId}
              orgPriority={org?.priority ?? 0}
              pools={pools}
              compatibleModes={compatibleModes}
              onSetLimitMode={(poolType, mode) => onSetLimitMode(oq.orgId, poolType, mode)}
              onSetQuota={(poolType, quotaType, value) => onSetLimitQuota(oq.orgId, poolType, quotaType, value)}
              onSetPctQuota={(poolType, pctValue) => onSetLimitPctQuota(oq.orgId, poolType, pctValue)}
            />
          );
        })}
      </Stack>
    </Stack>
  );
};
