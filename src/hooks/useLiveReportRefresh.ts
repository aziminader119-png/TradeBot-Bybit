import {useEffect, useRef} from 'react';
import {refreshReportReads, resetReportReads} from '../components/light/reports.tsx';
import {reportChangeKey} from './reportChangeKey.mjs';

// App-level listener survives route changes, including the standalone symbol page.
export function useLiveReportRefresh(state: any) {
  const previous = useRef<string | null>(null);
  const scope = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const key = JSON.stringify([state.settings?.apiKeyMasked, state.settings?.isApiKeyConfigured, state.settings?.environment, state.settings?.apiHost]);
    if (scope.current !== null && scope.current !== key) resetReportReads();
    scope.current = key;
  }, [state?.settings]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followup = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state) return;
    const key = reportChangeKey(state);
    if (previous.current === key) return;
    const first = previous.current === null;
    previous.current = key;
    if (first) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      refreshReportReads(true);
      // Bybit closed-P&L indexing can lag the position/execution notification.
      if (followup.current) clearTimeout(followup.current);
      followup.current = setTimeout(() => refreshReportReads(true), 2500);
    }, 500);
  }, [state]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') refreshReportReads(); };
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
      if (timer.current) clearTimeout(timer.current);
      if (followup.current) clearTimeout(followup.current);
    };
  }, []);
}

