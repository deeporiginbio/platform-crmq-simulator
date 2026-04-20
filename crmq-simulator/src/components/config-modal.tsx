/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState } from 'react';
import { Box, Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import type { CRMQConfig, Org } from '@/lib/types';
import { vcpuFromCpuMillis, gbFromMemoryMiB, cpuMillisFromVcpu, memoryMiBFromGb } from '@/lib/units';
import classes from './config-modal.module.css';

interface ConfigModalProps {
  cfg: CRMQConfig;
  orgs: Org[];
  onSave: (cfg: CRMQConfig, orgs: Org[]) => void;
  onClose: () => void;
}

interface CFProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}

const CF = ({ label, value, onChange, step = 1, min, max }: CFProps) => (
  <Box>
    <Text size="xs" c="dimmed" mb={4}>{label}</Text>
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={classes.cfgInput}
    />
  </Box>
);

export const ConfigModal = ({ cfg, orgs, onSave, onClose }: ConfigModalProps) => {
  // Deep clone config but preserve routeWhen functions (not serializable)
  const [lc, setLc] = useState<CRMQConfig>(() => {
    const clone: CRMQConfig = JSON.parse(JSON.stringify(cfg));
    clone.cluster.pools = clone.cluster.pools.map((pool, i) => ({
      ...pool,
      routeWhen: cfg.cluster.pools[i]?.routeWhen ?? (() => false),
    }));
    return clone;
  });
  const [lo, setLo] = useState<Org[]>(JSON.parse(JSON.stringify(orgs)));
  const [tab, setTab] = useState<'scoring' | 'scheduler' | 'cluster' | 'orgs'>('scoring');

  const setPath = (path: string, val: string | number) => {
    setLc((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split('.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = next;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = isNaN(Number(val)) ? val : Number(val);
      return next;
    });
  };

  const setOrg = (idx: number, field: string, val: string | number) => {
    setLo((prev) => {
      const next: Org[] = JSON.parse(JSON.stringify(prev));
      // field format: "limits.mason.cpu" or "priority" or "name"
      const parts = field.split('.');
      if (parts[0] === 'limits' && parts.length === 3) {
        const poolType = parts[1];
        const dim = parts[2] as 'cpu' | 'memory' | 'gpu';
        if (!next[idx].limits[poolType]) {
          next[idx].limits[poolType] = {
            cpuMillis: 0,
            memoryMiB: 0,
            gpu: 0,
          };
        }
        if (dim === 'cpu') {
          next[idx].limits[poolType].cpuMillis = cpuMillisFromVcpu(Number(val));
        } else if (dim === 'memory') {
          next[idx].limits[poolType].memoryMiB = memoryMiBFromGb(Number(val));
        } else {
          next[idx].limits[poolType][dim] = Number(val);
        }
      } else if (field === 'name') {
        next[idx].name = String(val);
      } else if (field === 'priority') {
        next[idx].priority = Number(val);
      }
      return next;
    });
  };

  const { scoring: s, scheduler: sch, cluster: cl } = lc;
  const TABS = ['scoring', 'scheduler', 'cluster', 'orgs'] as const;

  return (
    <div className={classes.overlay}>
      <Box className={classes.modal}>
        <div className={classes.header}>
          <Text c="grey.9" fw={700}>⚙ Configuration</Text>
          <Text component="button" onClick={onClose} c="dimmed" size="xl" style={{ cursor: 'pointer', background: 'none', border: 'none' }}>×</Text>
        </div>

        <div className={classes.tabs}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`${classes.tab} ${tab === t ? classes.tabActive : ''}`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className={classes.body}>
          <Stack gap="md">
            {tab === 'scoring' && (
              <>
                <div className={classes.formulaBox}>
                  Score = (OrgP × <span className={classes.formulaHighlight}>orgWeight</span>)
                       + (UserP × <span className={classes.formulaHighlight}>userWeight</span>)
                       + (ToolP × <span className={classes.formulaHighlight}>toolWeight</span>)
                       + (Wait × <span className={classes.formulaBlue}>agingFactor</span>)
                </div>
                <SimpleGrid cols={2} spacing="sm">
                  <CF label="Org Weight" value={s.orgWeight} onChange={(v) => setPath('scoring.orgWeight', v)} />
                  <CF label="User Weight" value={s.userWeight} onChange={(v) => setPath('scoring.userWeight', v)} />
                  <CF label="Tool Weight" value={s.toolWeight} onChange={(v) => setPath('scoring.toolWeight', v)} />
                  <CF label="Aging Factor" value={s.agingFactor} onChange={(v) => setPath('scoring.agingFactor', v)} />
                </SimpleGrid>
              </>
            )}
            {tab === 'scheduler' && (
              <>
                <div className={classes.formulaBox}>
                  Top-N={'{'}topN{'}'} · skipThreshold={'{'}X{'}'} → Reservation Mode · Backfill ≤ ratio × blocked
                </div>
                <SimpleGrid cols={2} spacing="sm">
                  <CF label="Top N" value={sch.topN} onChange={(v) => setPath('scheduler.topN', v)} />
                  <CF label="Skip Threshold" value={sch.skipThreshold} onChange={(v) => setPath('scheduler.skipThreshold', v)} />
                  <CF label="Backfill Ratio" value={sch.backfillMaxRatio} onChange={(v) => setPath('scheduler.backfillMaxRatio', v)} step={0.05} />
                </SimpleGrid>
              </>
            )}
            {tab === 'cluster' && (
              <>
                <div className={classes.formulaBox}>Available = Total − Reserved − InUse</div>
                {cl.pools.map((pool, poolIdx) => (
                  <Box key={pool.type}>
                    <Text className={classes.subheading}>{pool.label}</Text>
                    <SimpleGrid cols={3} spacing="sm">
                      <CF
                        label="CPU (cores)"
                        value={vcpuFromCpuMillis(pool.total.cpuMillis)}
                        onChange={(v) =>
                          setPath(
                            `cluster.pools.${poolIdx}.total.cpuMillis`,
                            cpuMillisFromVcpu(v)
                          )
                        }
                      />
                      <CF
                        label="Memory (GB)"
                        value={gbFromMemoryMiB(pool.total.memoryMiB)}
                        onChange={(v) =>
                          setPath(
                            `cluster.pools.${poolIdx}.total.memoryMiB`,
                            memoryMiBFromGb(v)
                          )
                        }
                      />
                      <CF
                        label="GPU (cards)"
                        value={pool.total.gpu}
                        onChange={(v) =>
                          setPath(`cluster.pools.${poolIdx}.total.gpu`, v)
                        }
                      />
                    </SimpleGrid>
                    <Text className={classes.subheading} mt="md">Reserved</Text>
                    <SimpleGrid cols={3} spacing="sm">
                      <CF
                        label="CPU"
                        value={vcpuFromCpuMillis(pool.reserved.cpuMillis)}
                        onChange={(v) =>
                          setPath(
                            `cluster.pools.${poolIdx}.reserved.cpuMillis`,
                            cpuMillisFromVcpu(v)
                          )
                        }
                      />
                      <CF
                        label="Memory"
                        value={gbFromMemoryMiB(pool.reserved.memoryMiB)}
                        onChange={(v) =>
                          setPath(
                            `cluster.pools.${poolIdx}.reserved.memoryMiB`,
                            memoryMiBFromGb(v)
                          )
                        }
                      />
                      <CF
                        label="GPU"
                        value={pool.reserved.gpu}
                        onChange={(v) =>
                          setPath(`cluster.pools.${poolIdx}.reserved.gpu`, v)
                        }
                      />
                    </SimpleGrid>
                  </Box>
                ))}
              </>
            )}
            {tab === 'orgs' && (
              <Stack gap="md">
                {lo.map((org, i) => (
                  <Box key={org.id} className={classes.orgSection}>
                    <Stack gap="sm">
                      <Group justify="space-between">
                        <Text>
                          <span className={classes.orgName}>{org.name}</span>{' '}
                          <span className={classes.orgId}>{org.id}</span>
                        </Text>
                        <Box style={{ width: 80 }}>
                          <CF label="Priority" value={org.priority} onChange={(v) => setOrg(i, 'priority', v)} min={1} max={10} />
                        </Box>
                      </Group>
                      {lc.cluster.pools.map((pool) => (
                        <Box key={pool.type}>
                          <Text size="xs" fw={600} style={{ color: pool.color }} mb={4}>
                            {pool.label}
                          </Text>
                          <SimpleGrid cols={3} spacing="xs">
                            <CF
                              label="CPU Limit"
                              value={vcpuFromCpuMillis(
                                org.limits[pool.type]?.cpuMillis ?? 0
                              )}
                              onChange={(v) =>
                                setOrg(i, `limits.${pool.type}.cpu`, v)
                              }
                            />
                            <CF
                              label="MEM Limit"
                              value={gbFromMemoryMiB(
                                org.limits[pool.type]?.memoryMiB ?? 0
                              )}
                              onChange={(v) =>
                                setOrg(i, `limits.${pool.type}.memory`, v)
                              }
                            />
                            <CF
                              label="GPU Limit"
                              value={org.limits[pool.type]?.gpu ?? 0}
                              onChange={(v) =>
                                setOrg(i, `limits.${pool.type}.gpu`, v)
                              }
                            />
                          </SimpleGrid>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
        </div>

        <div className={classes.footer}>
          <Button variant="outline" color="grey" onClick={onClose} fullWidth>Cancel</Button>
          <Button variant="filled" onClick={() => { onSave(lc, lo); onClose(); }} fullWidth fw={700} color="indigo">✓ Apply</Button>
        </div>
      </Box>
    </div>
  );
};
