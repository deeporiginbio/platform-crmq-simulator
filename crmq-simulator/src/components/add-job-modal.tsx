/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useState } from 'react';
import { Box, Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import type { Job, Org, CRMQConfig } from '@/lib/types';
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

export const AddJobModal = ({ cfg, orgs, onAdd, onClose }: AddJobModalProps) => {
  const [f, setF] = useState({
    name: 'Custom Job',
    orgId: orgs[0]?.id ?? '',
    userPriority: 3,
    toolPriority: 2,
    cpu: 2,
    memory: 8,
    gpu: 0,
    estimatedDuration: 60,
    ttl: Infinity,
  });

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const org = orgs.find((o) => o.id === f.orgId);
  const score = org
    ? org.priority * cfg.scoring.orgWeight + f.userPriority * cfg.scoring.userWeight + f.toolPriority * cfg.scoring.toolWeight
    : 0;

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
              <input value={f.name} onChange={(e) => set('name', e.target.value)} className={classes.cfgInput} />
            </Field>
            <SimpleGrid cols={3} spacing="xs">
              <Field label="Org">
                <select value={f.orgId} onChange={(e) => set('orgId', e.target.value)} className={classes.cfgInput}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
              <Field label="User P (1–5)">
                <input type="number" min={1} max={5} value={f.userPriority} onChange={(e) => set('userPriority', Math.min(5, Math.max(1, +e.target.value)))} className={classes.cfgInput} />
              </Field>
              <Field label="Tool P (1–5)">
                <input type="number" min={1} max={5} value={f.toolPriority} onChange={(e) => set('toolPriority', Math.min(5, Math.max(1, +e.target.value)))} className={classes.cfgInput} />
              </Field>
            </SimpleGrid>
            <SimpleGrid cols={3} spacing="xs">
              <Field label="CPU"><input type="number" min={0} value={f.cpu} onChange={(e) => set('cpu', +e.target.value)} className={classes.cfgInput} /></Field>
              <Field label="Memory (GB)"><input type="number" min={0} value={f.memory} onChange={(e) => set('memory', +e.target.value)} className={classes.cfgInput} /></Field>
              <Field label="GPU"><input type="number" min={0} value={f.gpu} onChange={(e) => set('gpu', +e.target.value)} className={classes.cfgInput} /></Field>
            </SimpleGrid>
            <Field label="Duration (s)"><input type="number" min={1} value={f.estimatedDuration} onChange={(e) => set('estimatedDuration', +e.target.value)} className={classes.cfgInput} /></Field>
            <Box className={classes.formulaBox}>
              <Text size="xs" c="dimmed">Initial score:</Text>
              <Text className={classes.scoreValue}>{score.toLocaleString()}</Text>
            </Box>
          </Stack>
          <Group gap="sm" grow>
            <Button variant="outline" color="grey" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => {
                onAdd({
                  name: f.name,
                  orgId: f.orgId,
                  userPriority: f.userPriority,
                  toolPriority: f.toolPriority,
                  resources: {
                    cpuMillis: cpuMillisFromVcpu(f.cpu),
                    memoryMiB: memoryMiBFromGb(f.memory),
                    gpu: f.gpu,
                  },
                  estimatedDuration: f.estimatedDuration,
                  ttl: f.ttl,
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
