/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

/**
 * Reports Page
 * =============
 * Lists auto-saved benchmark reports as summary
 * cards. Each card shows formulas, scenarios, and
 * a summary. Users can expand a card for detail,
 * re-export in any format, or delete.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  listReports,
  deleteReport,
} from '@/lib/persistence';
import type { SavedReport } from '@/lib/persistence';
import {
  exportPDFReport,
  exportMarkdownReport,
  exportJSONReport,
  exportCSVReport,
} from '@/lib/benchmark';
import type {
  MultiScenarioEntry,
} from '@/lib/benchmark-store';

// ── Helpers ──────────────────────────────────────

const fmtDate = (epoch: number): string => {
  const d = new Date(epoch);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const relTime = (epoch: number): string => {
  const diff = Date.now() - epoch;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

// ── Report Card ──────────────────────────────────

interface ReportCardProps {
  report: SavedReport;
  onDelete: (id: string) => void;
}

const ReportCard = ({
  report,
  onDelete,
}: ReportCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const { summary } = report.report;
  const hasEntries =
    report.entries && report.entries.length > 0;

  const handleExport = useCallback(
    async (
      format: 'pdf' | 'md' | 'json' | 'csv',
    ) => {
      if (!hasEntries) return;
      const entries =
        report.entries as MultiScenarioEntry[];
      switch (format) {
        case 'pdf':
          await exportPDFReport(entries);
          break;
        case 'md':
          exportMarkdownReport(entries);
          break;
        case 'json':
          exportJSONReport(entries);
          break;
        case 'csv':
          exportCSVReport(entries);
          break;
      }
    },
    [hasEntries, report.entries],
  );

  return (
    <Card
      shadow="xs"
      padding="md"
      radius="md"
      withBorder
      style={{
        borderColor: expanded
          ? '#4C6EF5'
          : undefined,
        transition: 'border-color 150ms',
      }}
    >
      {/* Header row */}
      <Group justify="space-between" wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} truncate>
              {report.name}
            </Text>
            <Badge
              size="xs"
              variant="light"
              color="grey"
            >
              {relTime(report.createdAt)}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed" mt={2}>
            {fmtDate(report.createdAt)}
          </Text>
        </Box>

        <Group gap="xs" wrap="nowrap">
          {/* Export menu */}
          <Menu
            shadow="md"
            position="bottom-end"
            withinPortal
          >
            <Menu.Target>
              <Tooltip label="Export report">
                <ActionIcon
                  variant="subtle"
                  color="indigo"
                  disabled={!hasEntries}
                  size="sm"
                >
                  <Text size="sm">⬇</Text>
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Export format</Menu.Label>
              <Menu.Item
                onClick={() => handleExport('pdf')}
              >
                PDF Report
              </Menu.Item>
              <Menu.Item
                onClick={() => handleExport('md')}
              >
                Markdown
              </Menu.Item>
              <Menu.Item
                onClick={() => handleExport('json')}
              >
                JSON
              </Menu.Item>
              <Menu.Item
                onClick={() => handleExport('csv')}
              >
                CSV
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>

          {/* Expand/collapse */}
          <Tooltip
            label={
              expanded ? 'Collapse' : 'Expand'
            }
          >
            <ActionIcon
              variant="subtle"
              color="grey"
              size="sm"
              onClick={() =>
                setExpanded((v) => !v)
              }
            >
              <Text size="sm">
                {expanded ? '▲' : '▼'}
              </Text>
            </ActionIcon>
          </Tooltip>

          {/* Delete */}
          <Tooltip label="Delete report">
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              onClick={() => onDelete(report.id)}
            >
              <Text size="sm">✕</Text>
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {/* Metadata badges + summary */}
      <Group gap="sm" mt="sm">
        {report.report.formulaNames?.length > 0 && (
          <Badge
            variant="light"
            color="indigo"
            size="xs"
          >
            {report.report.formulaNames.length}{' '}
            formula
            {report.report.formulaNames.length !== 1
              ? 's'
              : ''}
          </Badge>
        )}
        {report.entries && (
          <Badge
            variant="outline"
            color="grey"
            size="xs"
          >
            {report.entries.length} scenario
            {report.entries.length !== 1
              ? 's'
              : ''}
          </Badge>
        )}
      </Group>

      <Text size="sm" c="dimmed" mt="xs">
        {summary}
      </Text>

      {/* Expanded detail */}
      <Collapse in={expanded}>
        <Box
          mt="md"
          p="sm"
          style={{
            background: '#F9FAFB',
            borderRadius: 8,
          }}
        >
          {/* Formulas */}
          {report.report.formulaNames?.length > 0 && (
            <>
              <Text
                size="xs"
                fw={600}
                c="grey.7"
                mb="xs"
              >
                Formulas compared
              </Text>
              <Group gap={4} mb="sm">
                {report.report.formulaNames.map(
                  (fn) => (
                    <Badge
                      key={fn}
                      size="xs"
                      variant="light"
                      color="indigo"
                    >
                      {fn}
                    </Badge>
                  ),
                )}
              </Group>
            </>
          )}

          {/* Scenario list */}
          {report.entries &&
            report.entries.length > 0 && (
            <>
              <Text
                size="xs"
                fw={600}
                c="grey.7"
                mt="md"
                mb="xs"
              >
                Scenarios
              </Text>
              <Stack gap={4}>
                {report.entries.map(
                  (entry, i) => {
                    const r = entry.result;
                    const formulas =
                      r.scenarios
                        .map(
                          (s) => s.scenarioName,
                        )
                        .join(', ');
                    return (
                      <Group
                        key={i}
                        justify="space-between"
                      >
                        <Text
                          size="xs"
                          c="dimmed"
                        >
                          {entry.preset.name}
                        </Text>
                        <Text
                          size="xs"
                          c="grey.6"
                        >
                          {formulas}
                        </Text>
                      </Group>
                    );
                  },
                )}
              </Stack>
            </>
          )}

          {!hasEntries && (
            <Text
              size="xs"
              c="dimmed"
              fs="italic"
              mt="xs"
            >
              Raw benchmark data not available
              for this report (legacy save).
              Export is disabled.
            </Text>
          )}
        </Box>
      </Collapse>
    </Card>
  );
};

// ── Empty State ──────────────────────────────────

const EmptyState = () => (
  <Box
    p="xl"
    style={{
      background: '#F9FAFB',
      border: '2px dashed #E5E7EA',
      borderRadius: 12,
      textAlign: 'center',
    }}
  >
    <Stack gap="sm" align="center">
      <Text size="xl">📋</Text>
      <Text fw={600} c="grey.7">
        No reports yet
      </Text>
      <Text size="sm" c="dimmed" maw={400}>
        Reports are automatically saved when a
        benchmark run completes. They include
        comparison summaries and metric
        breakdowns.
      </Text>
      <Text size="xs" c="dimmed" mt="xs">
        Run a benchmark first to generate a report
      </Text>
    </Stack>
  </Box>
);

// ── Main Page ────────────────────────────────────

const ReportsPage = () => {
  const [reports, setReports] = useState<
    SavedReport[]
  >([]);

  const loadReports = useCallback(() => {
    setReports(listReports());
  }, []);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleDelete = useCallback(
    (id: string) => {
      deleteReport(id);
      loadReports();
    },
    [loadReports],
  );

  const handleClearAll = useCallback(() => {
    for (const r of reports) {
      deleteReport(r.id);
    }
    loadReports();
  }, [reports, loadReports]);

  return (
    <Box p="md">
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between">
          <Box>
            <Text size="xl" fw={700} c="grey.9">
              Reports
            </Text>
            <Text size="xs" c="dimmed" mt={2}>
              Saved benchmark results and generated
              summaries
            </Text>
          </Box>
          {reports.length > 0 && (
            <Button
              variant="subtle"
              color="red"
              size="compact-sm"
              onClick={handleClearAll}
            >
              Clear all
            </Button>
          )}
        </Group>

        {/* Report list or empty state */}
        {reports.length === 0 ? (
          <EmptyState />
        ) : (
          <Stack gap="sm">
            {reports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                onDelete={handleDelete}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Box>
  );
};

export default ReportsPage;
