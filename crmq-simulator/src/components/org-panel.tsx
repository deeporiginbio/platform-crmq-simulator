/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState } from 'react';
import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import type { Org, OrgUsageMap, ResourcePool, Resources, CRMQConfig } from '@/lib/types';
import { zeroPoolUsage } from '@/lib/scheduler';
import classes from './org-panel.module.css';

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

export const OrgPanel = ({ orgs, orgUsage, pools, cfg }: OrgPanelProps) => {
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
          const totalUsedCpu = pools.reduce((s, p) => s + (usage[p.type]?.cpu ?? 0), 0);
          const totalLimitCpu = pools.reduce((s, p) => s + (org.limits[p.type]?.cpu ?? 0), 0);
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
                    const poolUsage = usage[pool.type] ?? { cpu: 0, memory: 0, gpu: 0 };
                    const poolLimits = org.limits[pool.type] ?? { cpu: 0, memory: 0, gpu: 0 };

                    return (
                      <Box key={pool.type} className={classes.poolBlock}>
                        <Text className={classes.poolTag} style={{ color: pool.color }}>
                          {pool.shortLabel} Pool
                        </Text>
                        <div className={classes.resourceGrid}>
                          <MiniBar used={poolUsage.cpu} limit={poolLimits.cpu} color="#4A65DC" />
                          <Text className={classes.resourceDimLabel}>CPU</Text>
                          <MiniBar used={poolUsage.memory} limit={poolLimits.memory} color="#7638E5" />
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
};
