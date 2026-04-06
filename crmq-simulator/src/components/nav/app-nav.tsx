/* Copyright Deep Origin, Inc. [2019-2026]. All rights reserved. */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import classes from './app-nav.module.css';

const NAV_ITEMS = [
  { href: '/simulator', label: 'Simulator', icon: '⚙' },
  { href: '/configure', label: 'Configuration', icon: '🎛' },
  { href: '/scenarios', label: 'Scenarios', icon: '🧪' },
  { href: '/benchmarks', label: 'Benchmarks', icon: '📊' },
  { href: '/reports', label: 'Reports', icon: '📋' },
] as const;

export const AppNav = () => {
  const pathname = usePathname();

  return (
    <nav className={classes.nav}>
      <Link href="/simulator" className={classes.brand}>
        <span className={classes.brandIcon}>⚙</span>
        <span className={classes.brandLabel}>CRMQ</span>
      </Link>

      <div className={classes.navLinks}>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || (item.href === '/simulator' && pathname === '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${classes.navLink} ${isActive ? classes.navLinkActive : ''}`}
            >
              <span className={classes.navIcon}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </div>

    </nav>
  );
};
