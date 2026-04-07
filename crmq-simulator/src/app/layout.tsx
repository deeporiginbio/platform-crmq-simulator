/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

import type { Metadata } from 'next';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/lib/theme';
import { AppNav } from '@/components/nav/app-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'CRMQ Virtual Cluster Simulator',
  description: 'Cost & Resource Management Queue — Priority Scheduling Simulator',
  icons: {
    icon: '/favicon.ico',
  },
};

const RootLayout = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <MantineProvider theme={theme}>
          <AppNav />
          {children}
        </MantineProvider>
      </body>
    </html>
  );
};

export default RootLayout;
