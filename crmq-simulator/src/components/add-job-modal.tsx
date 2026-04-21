/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useMemo, useState } from 'react';
import { Box, Button, Checkbox, Group, SimpleGrid, Stack, Tabs, Text } from '@mantine/core';
import type { Job, Org, CRMQConfig, Resources, ResourcesByType } from '@/lib/types';
import {
  cpuMillisFromVcpu,
  memoryMiBFromGb,
} from '@/lib/units';
import classes from './add-job-modal.module.css';

interface AddJobModalProps {
  cfg: CRMQConfig;
  orgs: Org[];
  onAdd: (job: Omit<Job, 'id' | 'enqueuedAt' | 'skipCount'>) => void;
  onClose: () => void;
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

const Field = ({ label, children }: FieldProps) => (
  <Box>
    <Text size="xs" c="dimmed" mb={4}>{label}</Text>
    {children}
  </Box>
);

/** UI-level per-pool form state (vCPU + GB, converted to cpuMillis/memoryMiB at submit). */
interface PoolSlice {
  enabled: boolean;
  cpu: number;
  memory: number;
  gpu: number;
}

const defaultSliceForPool = (quotaType: 'cpu' | 'gpu'): PoolSlice =>
  quotaType === 'gpu'
    ? { enabled: false, cpu: 1, memory: 4, gpu: 1 }
    : { enabled: false, cpu: 2, memory: 8, gpu: 0 };

export const AddJobModal = ({ cfg, orgs, onAdd, onClose }: AddJobModalProps) => {
  // Header fields
  const [name, setName] = useState('Custom Job');
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [userPriority, setUserPriority] = useState(3);
  const [toolPriority, setToolPriority] = useState(2);
  const [estimatedDuration, setEstimatedDuration] = useState(60);

  // Per-pool slice state — one entry per pool in config, first one enabled by default
  const [slices, setSlices] = useState<Record<string, PoolSlice>>(() => {
    const init: Record<string, PoolSlice> = {};
    cfg.cluster.pools.forEach((p, i) => {
      const slice = defaultSliceForPool(p.quotaType);
      if (i === 0) slice.enabled = true;
      init[p.type] = slice;
    });
    return init;
  });

  const [activeTab, setActiveTab] = useState<string | null>(cfg.cluster.pools[0]?.type ?? null);

  const setSlice = (poolType: string, patch: Partial<PoolSlice>) =>
    setSlices((prev) => ({ ...prev, [poolType]: { ...prev[poolType], ...patch } }));

  const enabledPools = useMemo(
    () => cfg.cluster.pools.filter((p) => slices[p.type]?.enabled),
    [cfg.cluster.pools, slices],
  );

  const resourcesByType: ResourcesByType = useMemo(() => {
    const out: ResourcesByType = {};
    for (const p of cfg.cluster.pools) {
      const s = slices[p.type];
      if (!s?.enabled) continue;
      const r: Resources = {
        cpuMillis: cpuMillisFromVcpu(s.cpu),
        memoryMiB: memoryMiBFromGb(s.memory),
        gpu: s.gpu,
      };
      out[p.type] = r;
    }
    return out;
  }, [cfg.cluster.pools, slices]);

  const org = orgs.find((o) => o.id === orgId);
  const score = org
    ? org.priority * cfg.scoring.orgWeight + userPriority * cfg.scoring.userWeight + toolPriority * cfg.scoring.toolWeight
    : 0;

  const canSubmit = enabledPools.length > 0;

  return (
    <div className={classes.overlay}>
      <Box className={classes.modal}>
        <Stack gap="md">
          <Group justify="space-between">
            <Text c="grey.9" fw={700}>Enqueue New Job</Text>
            <Text component="button" onClick={onClose} c="dimmed" size="xl" style={{ cursor: 'pointer', background: 'none', border: 'none' }}>×</Text>
          </Group>
          <Stack gap="sm">
            <Field label="Job Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={classes.cfgInput} />
            </Field>
            <SimpleGrid cols={3} spacing="xs">
              <Field label="Org">
                <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={classes.cfgInput}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
              <Field label="User P (1–5)">
                <input type="number" min={1} max={5} value={userPriority} onChange={(e) => setUserPriority(Math.min(5, Math.max(1, +e.target.value)))} className={classes.cfgInput} />
              </Field>
              <Field label="Tool P (1–5)">
                <input type="number" min={1} max={5} value={toolPriority} onChange={(e) => setToolPriority(Math.min(5, Math.max(1, +e.target.value)))} className={classes.cfgInput} />
              </Field>
            </SimpleGrid>

            <Box>
              <Text size="xs" c="dimmed" mb={4}>Resource Pools</Text>
              <Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
                <Tabs.List>
                  {cfg.cluster.pools.map((p) => {
                    const s = slices[p.type];
                    return (
                      <Tabs.Tab
                        key={p.type}
                        value={p.type}
                        rightSection={
                          s?.enabled ? (
                            <Text
                              size="xs"
                              fw={700}
                              style={{
                                background: p.color,
                                color: '#fff',
                                borderRadius: 10,
                                padding: '0 6px',
                                lineHeight: '16px',
                                minWidth: 16,
                                textAlign: 'center',
                              }}
                            >
                              ✓
                            </Text>
                          ) : null
                        }
                      >
                        <span style={{ color: p.color, fontWeight: 600 }}>{p.shortLabel}</span>
                      </Tabs.Tab>
                    );
                  })}
                </Tabs.List>
                {cfg.cluster.pools.map((p) => {
                  const s = slices[p.type] ?? defaultSliceForPool(p.quotaType);
                  return (
                    <Tabs.Panel key={p.type} value={p.type} pt="xs">
                      <Stack gap="xs">
                        <Checkbox
                          label={`Include ${p.label}`}
                          checked={s.enabled}
                          onChange={(e) => setSlice(p.type, { enabled: e.currentTarget.checked })}
                          size="xs"
                        />
                        <SimpleGrid cols={3} spacing="xs">
                          <Field label="CPU (vCPU)">
                            <input
                              type="number"
                              min={0}
                              value={s.cpu}
                              disabled={!s.enabled}
                              onChange={(e) => setSlice(p.type, { cpu: +e.target.value })}
                              className={classes.cfgInput}
                            />
                          </Field>
                          <Field label="Memory (GB)">
                            <input
                              type="number"
                              min={0}
                              value={s.memory}
                              disabled={!s.enabled}
                              onChange={(e) => setSlice(p.type, { memory: +e.target.value })}
                              className={classes.cfgInput}
                            />
                          </Field>
                          <Field label="GPU">
                            <input
                              type="number"
                              min={0}
                              value={s.gpu}
                              disabled={!s.enabled || p.quotaType !== 'gpu'}
                              onChange={(e) => setSlice(p.type, { gpu: +e.target.value })}
                              className={classes.cfgInput}
                            />
                          </Field>
                        </SimpleGrid>
                      </Stack>
                    </Tabs.Panel>
                  );
                })}
              </Tabs>
              {!canSubmit && (
                <Text size="xs" c="red.6" mt={4}>Select at least one pool.</Text>
              )}
            </Box>

            <Field label="Duration (s)">
              <input
                type="number"
                min={1}
                value={estimatedDuration}
                onChange={(e) => setEstimatedDuration(+e.target.value)}
                className={classes.cfgInput}
              />
            </Field>
            <Box className={classes.formulaBox}>
              <Text size="xs" c="dimmed">Initial score:</Text>
              <Text className={classes.scoreValue}>{score.toLocaleString()}</Text>
            </Box>
          </Stack>
          <Group gap="sm" grow>
            <Button variant="outline" color="grey" onClick={onClose}>Cancel</Button>
            <Button
              disabled={!canSubmit}
              onClick={() => {
                onAdd({
                  name,
                  orgId,
                  userPriority,
                  toolPriority,
                  resources: resourcesByType,
                  estimatedDuration,
                  ttl: Infinity,
                });
                onClose();
              }}
              fw={700}
            >
              Enqueue →
            </Button>
          </Group>
        </Stack>
      </Box>
    </div>
  );
};
