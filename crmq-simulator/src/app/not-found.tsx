/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

import { Button, Container, Text, Title, Stack } from '@mantine/core';
import Link from 'next/link';

const NotFound = () => {
  return (
    <Container size="xs" py={80}>
      <Stack align="center" gap="md">
        <Text size="72px" fw={700} c="indigo.5" lh={1}>
          404
        </Text>
        <Title order={2} c="grey.8">
          Page not found
        </Title>
        <Text c="grey.5" ta="center">
          The page you are looking for doesn&apos;t exist or has been moved.
        </Text>
        <Button component={Link} href="/simulator" mt="sm">
          Back to Simulator
        </Button>
      </Stack>
    </Container>
  );
};

export default NotFound;
