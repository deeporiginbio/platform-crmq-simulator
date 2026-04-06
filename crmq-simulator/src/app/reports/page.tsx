/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { Box, Button, Group, Stack, Text } from '@mantine/core';

const ReportsPage = () => {
  return (
    <Box p="md">
      <Stack gap="md">
        <Group justify="space-between">
          <Box>
            <Text size="xl" fw={700} c="grey.9">Reports</Text>
            <Text size="xs" c="dimmed" mt={2}>
              Saved benchmark results and generated summaries
            </Text>
          </Box>
          <Button variant="outline" color="indigo" size="compact-sm" disabled>
            Export
          </Button>
        </Group>

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
            <Text fw={600} c="grey.7">No reports yet</Text>
            <Text size="sm" c="dimmed" maw={400}>
              Reports are generated from completed benchmark runs. They include
              comparison summaries, metric breakdowns by org, and recommendations
              for optimal scheduling configuration.
            </Text>
            <Text size="xs" c="dimmed" mt="xs">
              Run a benchmark first to generate a report
            </Text>
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
};

export default ReportsPage;
