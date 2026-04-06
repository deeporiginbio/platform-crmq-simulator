/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import dynamic from 'next/dynamic';

const ConfigPageInner = dynamic(
  () => import('@/components/config/config-page-wrapper').then(m => ({ default: m.ConfigPageWrapper })),
  { ssr: false },
);

const ConfigurePage = () => <ConfigPageInner />;

export default ConfigurePage;
