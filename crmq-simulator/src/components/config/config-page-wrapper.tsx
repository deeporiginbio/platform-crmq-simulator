/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import { useRouter } from 'next/navigation';
import { useConfigStore } from '@/lib/store';
import { ConfigPage } from './config-page';

/**
 * Wrapper for the /configure route.
 * Reads cfg/orgs from the shared Zustand store and writes back on Apply.
 * The Simulator page reads from the same store, so changes take effect immediately.
 */
export const ConfigPageWrapper = () => {
  const router = useRouter();
  const cfg = useConfigStore((s) => s.cfg);
  const orgs = useConfigStore((s) => s.orgs);
  const applyConfig = useConfigStore((s) => s.applyConfig);

  return (
    <ConfigPage
      config={cfg}
      orgs={orgs}
      onApply={(newCfg, newOrgs) => {
        applyConfig(newCfg, newOrgs);
        router.push('/simulator');
      }}
      onCancel={() => router.push('/simulator')}
    />
  );
};
