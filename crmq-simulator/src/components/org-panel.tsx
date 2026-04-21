/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { memo, useState } from 'react';
import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import type { Org, OrgUsageMap, ResourcePool, CRMQConfig } from '@/lib/types';
import { zeroPoolUsage } from '@/lib/scheduler';
import { resolvePercentToResources } from '@/lib/config/types';
import { vcpuFromCpuMillis, gbFromMemoryMiB } from '@/lib/units';
import classes from './org-panel.module.css';

/**
 * Resolve an org's per-pool percentage quota to absolute Resources. A
 * missing key is treated as unlimited-within-pool, so we show the full
 * pool total (matches scheduler gate semantics).
 */
const resolveOrgPoolAbs = (org: Org, pool: ResourcePool) => {
  const pct = org.limits[pool.type];
  if (typeof pct !== 'number') return { ...pool.total };
  return resolvePercentToResources(pct, pool.total);
};

interface OrgPanelProps {
  orgs: Org[];
  orgUsage: OrgUsageMap;
  pools: ResourcePool[];
  cfg: CRMQConfig;
}

/** Tiny inline usage bar */
const MiniBar = ({ used, limit, color }: { used: number; limit: number; color: string }) => {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const barColor = pct > 90 ? '#D93E39' : pct > 70 ? '#B27700' : color;

  return (
    <Box className={classes.miniBarCell}>
      <div className={classes.miniBarTrack}>
        <div className={classes.miniBarFill} style={{ width: `${pct}%`, background: barColor }} />
      </div>
      <Text className={classes.miniBarLabel}>{used}/{limit}</Text>
    </Box>
  );
};

export const OrgPanel = memo(({ orgs, orgUsage, pools, cfg }: OrgPanelProps) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (orgId: string) => {
    setCollapsed(prev => ({ ...prev, [orgId]: !prev[orgId] }));
  };

  return (
    <Box className={classes.card}>
      <Stack gap="xs">
        <Text className={classes.sectionTitle}>Org Quotas</Text>

        {orgs.map((org) => {
          const isCollapsed = collapsed[org.id] ?? true;
          const usage = orgUsage[org.id] ?? zeroPoolUsage(cfg);

          // Summary: total utilization across pools
          const totalUsedCpu = pools.reduce(
            (s, p) =>
              s + vcpuFromCpuMillis(usage[p.type]?.cpuMillis ?? 0),
            0,
          );
          const totalLimitCpu = pools.reduce((s, p) => {
            const abs = resolveOrgPoolAbs(org, p);
            return s + vcpuFromCpuMillis(abs.cpuMillis);
          }, 0);
          const totalPct = totalLimitCpu > 0 ? Math.round((totalUsedCpu / totalLimitCpu) * 100) : 0;

          return (
            <Box key={org.id} className={classes.orgRow}>
              <UnstyledButton onClick={() => toggle(org.id)} className={classes.orgHeader}>
                <Stack gap={2} w="100%">
                  <Group gap={6}>
                    <Text size="xs" c="dimmed" className={classes.chevron}>
                      {isCollapsed ? '▸' : '▾'}
                    </Text>
                    <Text className={classes.orgName}>{org.name}</Text>
                    <Text className={classes.priorityBadge}>P{org.priority}</Text>
                  </Group>
                  {isCollapsed && (
                    <Text size="xs" ff="monospace" c="dimmed" ml={18}>
                      {totalPct}% CPU
                    </Text>
                  )}
                </Stack>
              </UnstyledButton>

              {!isCollapsed && (
                <div className={classes.gridBody}>
                  {pools.map((pool) => {
                    const poolUsage = usage[pool.type] ?? {
                      cpuMillis: 0,
                      memoryMiB: 0,
                      gpu: 0,
                    };
                    const poolLimits = resolveOrgPoolAbs(org, pool);

                    return (
                      <Box key={pool.type} className={classes.poolBlock}>
                        <Text className={classes.poolTag} style={{ color: pool.color }}>
                          {pool.shortLabel} Pool
                        </Text>
                        <div className={classes.resourceGrid}>
                          <MiniBar
                            used={vcpuFromCpuMillis(poolUsage.cpuMillis)}
                            limit={vcpuFromCpuMillis(poolLimits.cpuMillis)}
                            color="#4A65DC"
                          />
                          <Text className={classes.resourceDimLabel}>CPU</Text>
                          <MiniBar
                            used={gbFromMemoryMiB(poolUsage.memoryMiB)}
                            limit={gbFromMemoryMiB(poolLimits.memoryMiB)}
                            color="#7638E5"
                          />
                          <Text className={classes.resourceDimLabel}>MEM</Text>
                          {poolLimits.gpu > 0 && (
                            <>
                              <MiniBar used={poolUsage.gpu} limit={poolLimits.gpu} color="#11A468" />
                              <Text className={classes.resourceDimLabel}>GPU</Text>
                            </>
                          )}
                        </div>
                      </Box>
                    );
                  })}
                </div>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
});

OrgPanel.displayName = 'OrgPanel';
