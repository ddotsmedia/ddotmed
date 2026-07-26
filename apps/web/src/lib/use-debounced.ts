'use client';

import { useEffect, useState } from 'react';

/**
 * Debounces a rapidly-changing value.
 *
 * Instant search would otherwise fire a request per keystroke; at 300ms a typist
 * produces one request per pause rather than one per character, while still
 * feeling immediate.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
