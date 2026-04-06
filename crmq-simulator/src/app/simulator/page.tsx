/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import dynamic from 'next/dynamic';

const SimulatorPage = dynamic(
  () => import('@/components/simulator-page').then(mod => ({ default: mod.SimulatorPage })),
  {
    ssr: false,
    loading: () => (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <p style={{ color: '#888', fontSize: 14 }}>Loading simulator…</p>
      </div>
    ),
  },
);

const Page = () => <SimulatorPage />;

export default Page;
