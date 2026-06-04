'use client';
import SearchDialog from '@/components/search';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { type ReactNode } from 'react';

export function Provider({ children }: { children: ReactNode }) {
  // Space theme is dark-only — disable the light/dark toggle and force dark.
  return (
    <RootProvider search={{ SearchDialog }} theme={{ enabled: false, forcedTheme: 'dark' }}>
      {children}
    </RootProvider>
  );
}
