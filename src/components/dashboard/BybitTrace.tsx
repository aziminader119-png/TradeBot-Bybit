import React from 'react';

// Phase 4.1: the actual requests sent to Bybit, newest first. Never contains the key, secret or signature.
export interface TraceRow {
  at: number; method: string; host: string; path: string; params: string[]; signed: boolean; signMethod?: string;
  timestampSent?: string; recvWindow?: string; clockOffsetMs: number; durationMs: number;
  httpStatus?: number; retCode?: number; retMsg?: string; server?: string; outcome: string; note?: string;
}

export const BybitTrace: React.FC<{ rows?: TraceRow[] }> = ({ rows }) => {
  if (!rows?.length) return <div style={{ fontSize: 12.5, color: '#8d9098' }}>No request sent to Bybit yet.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12.5 }}>
        <thead><tr><th>Time</th><th>Request</th><th>Signed</th><th>HTTP</th><th>retCode</th><th>retMsg / detail</th><th>Answered by</th><th>ms</th></tr></thead>
        <tbody>{rows.map((r, i) => {
          const bad = r.outcome !== 'OK';
          return (
            <tr key={i} style={{ color: bad ? '#ed4f5d' : undefined }}>
              <td>{new Date(r.at).toLocaleTimeString()}</td>
              <td style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.method} {r.host}{r.path}{r.params.length ? `?${r.params.join('&')}` : ''}</td>
              <td>{r.signed ? `${r.signMethod || 'yes'} · ts ${r.timestampSent ?? '—'} · recv ${r.recvWindow ?? '—'} · offset ${r.clockOffsetMs} ms` : 'public'}</td>
              <td>{r.httpStatus ?? (r.outcome === 'NOT_SENT' ? 'not sent' : r.outcome)}</td>
              <td>{r.retCode ?? '—'}</td>
              <td style={{ whiteSpace: 'normal', maxWidth: 420 }}>{r.retMsg ?? ''}{r.note && (r.retMsg === undefined || bad) ? <div style={{ color: '#adb1b8' }}>{r.note}</div> : null}</td>
              <td>{r.server || '—'}</td>
              <td>{r.durationMs}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
};
