'use client';

import { useState, type ReactNode } from 'react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/lib/i18n';
import { SessionProvider } from '@/lib/session';
import { RealtimeProvider } from '@/lib/realtime';
import { ApiError } from '@/lib/api-client';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // A 401 that reaches this layer has already survived the api-client's
        // refresh-and-retry, so it is a real session loss. The api-client owns the
        // sign-out; the cache must not react to it independently, otherwise a
        // background refetch on a stale tab would log the user out mid-task.
        queryCache: new QueryCache({
          onError: (error, query) => {
            if (error instanceof ApiError && error.status === 401) {
              // Drop the stale entry so it does not refetch in a loop, and leave
              // the redirect to the session provider.
              queryClient.getQueryCache().find({ queryKey: query.queryKey })?.reset();
            }
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            // Background refetches must stay silent: a transient failure on a tab
            // the clinician is not looking at should never surface as an error.
            refetchOnReconnect: 'always',
            retry: (failureCount, error) => {
              if (error instanceof ApiError) {
                // 401 is already handled by the refresh interceptor; 403 and the
                // clinical 409s are deliberate server decisions, never retryable.
                if ([401, 403, 404, 409, 422].includes(error.status)) return false;
              }
              return failureCount < 2;
            },
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SessionProvider>
          <RealtimeProvider>{children}</RealtimeProvider>
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
