/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState } from 'react';
import {
  Badge,
  Box,
  Group,
  NumberInput,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import type { Resources, Org, QuotaType } from '@/lib/types';
import type { OrgQuotaConfig } from '@/lib/config/types';
import { resolvePercentToResources } from '@/lib/config/types';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '@/lib/units';
import classes from './org-quotas-step.module.css';

// ── Props ────────────────────────────────────────────────────────────────────

interface OrgQuotasStepProps {
  orgQuotas: OrgQuotaConfig[];
  pools: Array<{
    type: string;
    label: string;
    shortLabel: string;
    color: string;
    quotaType: QuotaType;
    total: Resources;
  }>;
  orgs: Org[];
  onSetLimitPctQuota: (
    orgId: string,
    poolType: string,
    pctValue: number,
  ) => void;
}

// ── Resolved Absolute Preview ────────────────────────────────────────────────

const ResolvedPreview = ({
  quotaType,
  resources,
}: {
  quotaType: QuotaType;
  resources: Resources;
}) => {
  const cpuBadge = (
    <Badge size="sm" variant="light" color="grey" radius="sm">
      CPU: {vcpuFromCpuMillis(resources.cpuMillis)} vCPU
    </Badge>
  );
  const memBadge = (
    <Badge size="sm" variant="light" color="grey" radius="sm">
      Mem: {gbFromMemoryMiB(resources.memoryMiB)} GB
    </Badge>
  );
  if (quotaType === 'gpu') {
    return (
      <Group gap="sm">
        <Text size="xs" c="dimmed">Resolves to:</Text>
        <Badge size="sm" variant="light" color="indigo" radius="sm">
          GPU: {resources.gpu}
        </Badge>
        {cpuBadge}
        {memBadge}
      </Group>
    );
  }
  return (
    <Group gap="sm">
      <Text size="xs" c="dimmed">Resolves to:</Text>
      {cpuBadge}
      {memBadge}
    </Group>
  );
};

// ── Pool Limit Card ──────────────────────────────────────────────────────────

const PoolLimitCard = ({
  poolLabel,
  poolColor,
  poolTotal,
  quotaType,
  pct,
  onSetPctQuota,
}: {
  poolLabel: string;
  poolColor: string;
  poolTotal: Resources;
  quotaType: QuotaType;
  pct: number;
  onSetPctQuota: (pctValue: number) => void;
}) => {
  const resolved = resolvePercentToResources(pct, poolTotal);
  return (
    <Box className={classes.poolCard}>
      <Group justify="space-between" mb="xs">
        <Group gap={6}>
          <Box
            className={classes.poolDot}
            style={{ background: poolColor }}
          />
          <Text size="xs" fw={600}>
            {poolLabel}
          </Text>
          <Badge size="xs" variant="outline" color="grey" radius="sm">
            {quotaType === 'gpu' ? 'GPU pool' : 'CPU pool'}
          </Badge>
        </Group>
      </Group>
      <Stack gap={8}>
        <NumberInput
          label="Quota %"
          description="Share of pool capacity (platform default: 100%)"
          size="xs"
          value={pct}
          onChange={(v) => onSetPctQuota(Number(v))}
          min={0}
          max={100}
          suffix="%"
          w={220}
        />
        <ResolvedPreview quotaType={quotaType} resources={resolved} />
      </Stack>
    </Box>
  );
};

// ── Org Quota Card ───────────────────────────────────────────────────────────

const OrgQuotaCard = ({
  orgQuota,
  orgName,
  orgPriority,
  pools,
  onSetPctQuota,
}: {
  orgQuota: OrgQuotaConfig;
  orgName: string;
  orgPriority: number;
  pools: OrgQuotasStepProps['pools'];
  onSetPctQuota: (poolType: string, pctValue: number) => void;
}) => {
  const [expanded, setExpanded] = useState(true);

  return (
    <Box className={classes.orgCard}>
      <UnstyledButton
        onClick={() => setExpanded((e) => !e)}
        className={classes.orgHeader}
      >
        <Group gap={8}>
          <Text size="xs" c="dimmed" className={classes.chevron}>
            {expanded ? '▾' : '▸'}
          </Text>
          <Text size="sm" fw={600}>
            {orgName}
          </Text>
          <Badge size="xs" variant="light" color="violet" radius="sm">
            P{orgPriority}
          </Badge>
        </Group>
        {!expanded && (
          <Text size="xs" c="dimmed" ff="monospace">
            {pools
              .map((p) => {
                const pct = orgQuota.limits[p.type];
                if (typeof pct !== 'number') {
                  return `${p.shortLabel}: —`;
                }
                return `${p.shortLabel}: ${pct}%`;
              })
              .join(' · ')}
          </Text>
        )}
      </UnstyledButton>

      {expanded && (
        <Stack gap="sm" mt="sm">
          {pools.map((pool) => {
            const pct = orgQuota.limits[pool.type];
            const current = typeof pct === 'number' ? pct : 100;

            return (
              <PoolLimitCard
                key={pool.type}
                poolLabel={pool.label}
                poolColor={pool.color}
                poolTotal={pool.total}
                quotaType={pool.quotaType}
                pct={current}
                onSetPctQuota={(pctValue) =>
                  onSetPctQuota(pool.type, pctValue)
                }
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
  onSetLimitPctQuota,
}: OrgQuotasStepProps) => {
  return (
    <Stack gap="md" mt="md">
      <Box>
        <Text size="sm" fw={600} c="grey.8">
          Per-Organization Resource Limits
        </Text>
        <Text size="xs" c="dimmed" mt={2}>
          One percentage per (org, pool), clamped to [0, 100] — matches the
          platform schema
          <Text span ff="monospace" size="xs" c="dimmed">
            {' organizations.resourceQuota numeric(6,2) default 100'}
          </Text>
          . The percentage applies uniformly to CPU, memory, and GPU.
        </Text>
      </Box>

      <Stack gap="sm">
        {orgQuotas.map((oq) => {
          const org = orgs.find((o) => o.id === oq.orgId);
          return (
            <OrgQuotaCard
              key={oq.orgId}
              orgQuota={oq}
              orgName={org?.name ?? oq.orgId}
              orgPriority={org?.priority ?? 0}
              pools={pools}
              onSetPctQuota={(poolType, pctValue) =>
                onSetLimitPctQuota(oq.orgId, poolType, pctValue)
              }
            />
          );
        })}
      </Stack>
    </Stack>
  );
};
