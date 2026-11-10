import {applySnapshotPatch} from '../shared/snapshotDelta.ts';
import { useState, useEffect, useCallback, useRef } from 'react';
import { BotStateSummary, SymbolTradingConfig, GlobalSettings, PositionOwner } from '../types/trading.ts';

export function useBotState() {
  const [state, setState] = useState<BotStateSummary | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const socketLastMessage = useRef(0);
  const lastRenderedHeartbeat = useRef(0);
  const snapshotVersion = useRef<number | null>(null);
  const fetching = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fallback REST fetch
  const fetchState = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    const started = Date.now();
    const controller = new AbortController();
    // A stalled REST fallback must never block all later recovery attempts.
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/state', { signal: controller.signal, cache: 'no-store' });
      if (res.ok) {
        const data: BotStateSummary = await res.json();
        if (socketLastMessage.current <= started) {
          // A REST result cannot replace a versioned WS baseline: the next patch is relative to that baseline.
          if (wsConnectedRef.current && snapshotVersion.current !== null) {
            if (Date.now() - socketLastMessage.current <= 6000) return;
            snapshotVersion.current = null;
            wsRef.current?.close(4000, 'State resync');
          }
          setState(data);
          setLastUpdated(Date.now());
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) console.warn('[useBotState] REST fetch error:', err);
    } finally { clearTimeout(timeout); fetching.current = false; }
  }, []);

  // WebSocket connect.
  // Phase 5 fix: the old effect depended on `wsConnected`, so every successful connect re-ran the effect,
  // which closed the socket it had just opened -> endless open/close, "Connecting…" badge and stale data.
  // Now one socket per mount, reconnect only after an unexpected close, never after our own close.
  const wsConnectedRef = useRef(false);
  const stoppedRef = useRef(false);
  const connectWs = useCallback(() => {
    if (stoppedRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws?updates=delta`);
    } catch {
      setWsConnected(false);
      return;
    }
    wsRef.current = ws;
    snapshotVersion.current = null;
    ws.onopen = () => { socketLastMessage.current = Date.now(); wsConnectedRef.current = true; setWsConnected(true); };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (wsRef.current !== ws) return;
        if (msg.type === 'SNAPSHOT' && msg.data) {
          snapshotVersion.current = Number.isInteger(msg.version) ? msg.version : null;
          socketLastMessage.current = Date.now();
          setWsConnected(true);
          setState(msg.data);
          setLastUpdated(Date.now());
        } else if (msg.type === 'PATCH' && msg.data) {
          if (snapshotVersion.current !== msg.baseVersion) { ws.close(4000, 'State resync'); return; }
          snapshotVersion.current = msg.version;
          socketLastMessage.current = Date.now();
          setWsConnected(true);
          // Version-only heartbeats must not force a dashboard-wide React render.
          // Real ticker/position/wallet patches still update immediately.
          const changed = Boolean(Object.keys(msg.data).length || msg.tickers &&
              (Object.keys(msg.tickers.upsert || {}).length || msg.tickers.removed?.length));
          if (changed) setState(previous => previous ? applySnapshotPatch(previous, msg) as BotStateSummary : previous);
          // Keep the freshness badge alive without repainting the page for each no-op frame.
          if (changed || Date.now() - lastRenderedHeartbeat.current >= 5000) {
            lastRenderedHeartbeat.current = Date.now();
            setLastUpdated(Date.now());
          }
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = (ev) => {
      wsConnectedRef.current = false;
      setWsConnected(false);
      if (wsRef.current === ws) wsRef.current = null;
      if (stoppedRef.current) return;
      if (ev.code === 4401) { window.dispatchEvent(new Event('tb-auth-required')); return; } // session ended
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(connectWs, 2000);
    };
    ws.onerror = () => { /* onclose follows and schedules the reconnect */ };
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    fetchState();
    connectWs();
    // A socket can remain OPEN while no snapshots arrive. Recover without a page refresh.
    const interval = setInterval(() => {
      const silentFor = Date.now() - socketLastMessage.current;
      if (silentFor > 15000) setWsConnected(false);
      if (!wsConnectedRef.current || silentFor > 15000) fetchState();
      if (wsConnectedRef.current && silentFor > 30000) wsRef.current?.close();
    }, 5000);
    return () => {
      stoppedRef.current = true;
      clearInterval(interval);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
      wsRef.current = null;
    };
  }, [fetchState, connectWs]);

  // Phase 1: credentials are never kept in the browser. Remove copies older builds stored,
  // and never re-send keys to the server automatically.
  useEffect(() => {
    try {
      localStorage.removeItem('tradebot_bybit_apiKey');
      localStorage.removeItem('tradebot_bybit_apiSecret');
    } catch {}
  }, []);

  // Mutations
  const updateSettings = async (updates: Partial<GlobalSettings> & { verificationPin?: string }) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update settings');
    }
    fetchState();
  };

  const updateSymbolConfig = async (symbol: string, config: Partial<SymbolTradingConfig>) => {
    const res = await fetch(`/api/symbols/${symbol}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update symbol config');
    }
    fetchState();
  };

  const deleteSymbol = async (symbol: string) => {
    const res = await fetch(`/api/symbols/${symbol}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete symbol');
    fetchState();
  };

  const toggleSymbol = async (symbol: string) => {
    const res = await fetch(`/api/symbols/${symbol}/toggle`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to toggle symbol');
    fetchState();
  };

  const unfreezePosition = async (id: string) => {
    const res = await fetch(`/api/positions/${encodeURIComponent(id)}/unfreeze`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to unfreeze position');
    fetchState();
  };

  const closePosition = async (id: string) => {
    const res = await fetch(`/api/positions/${encodeURIComponent(id)}/close`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to close position');
    fetchState();
  };

  const transferOwnership = async (id: string, targetOwner: PositionOwner) => {
    const res = await fetch(`/api/positions/${encodeURIComponent(id)}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetOwner }),
    });
    if (!res.ok) throw new Error('Failed to transfer ownership');
    fetchState();
  };

  const transferBulk = async (positionIds: string[], targetOwner: PositionOwner) => {
    const res = await fetch('/api/positions/transfer-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionIds, targetOwner }),
    });
    if (!res.ok) throw new Error('Failed to bulk transfer');
    fetchState();
  };

  const restartCycle = async (symbol: string) => {
    const res = await fetch(`/api/cycle/${symbol}/restart`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to restart cycle');
    fetchState();
  };

  const emergencyStop = async (pin: string) => {
    const res = await fetch('/api/emergency-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to trigger emergency stop');
    }
    fetchState();
  };

  const resumeEmergency = async (pin: string) => {
    const res = await fetch('/api/emergency-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to resume trading');
    }
    fetchState();
  };

  const pauseTrading = async () => {
    const res = await fetch('/api/engine/pause', { method: 'POST' });
    const data = await res.json();
    fetchState();
    if (!res.ok) throw new Error(data.error || 'Failed to pause');
    return data;
  };

  const resumeTrading = async (pin: string) => {
    const res = await fetch('/api/engine/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    fetchState();
    if (!res.ok) throw new Error(data.error || 'Failed to resume');
    return data;
  };

  const testBybitConnection = async () => {
    const res = await fetch('/api/bybit/test-connection', { method: 'POST' });
    return res.json();
  };

  const syncBybitPositions = async () => {
    const res = await fetch('/api/bybit/sync-positions', { method: 'POST' });
    const data = await res.json();
    fetchState();
    return data;
  };

  const clearAlerts = async () => {
    await fetch('/api/alerts/clear', { method: 'POST' });
    fetchState();
  };

  const markAlertsRead = async () => {
    await fetch('/api/alerts/mark-read', { method: 'POST' });
    fetchState();
  };

  return {
    state,
    wsConnected,
    lastUpdated,
    refresh: fetchState,
    updateSettings,
    updateSymbolConfig,
    deleteSymbol,
    toggleSymbol,
    unfreezePosition,
    closePosition,
    transferOwnership,
    transferBulk,
    restartCycle,
    emergencyStop,
    resumeEmergency,
    testBybitConnection,
    syncBybitPositions,
    pauseTrading,
    resumeTrading,
    clearAlerts,
    markAlertsRead,
  };
}


