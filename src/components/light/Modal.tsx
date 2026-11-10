import React, { useEffect, useId, useState } from 'react';

import {useDialogFocus} from './useDialogFocus.ts';

// Confirmation modal + toast of the approved light design (.modal-backdrop / .modal-card / .toast).

export const LightModal: React.FC<{
  open: boolean; title: string; children: React.ReactNode; confirmLabel?: string; busy?: boolean; error?: string | null;
  onConfirm?: () => void; onClose: () => void; testid?: string;
}> = ({ open, title, children, confirmLabel = 'Confirm', busy, error, onConfirm, onClose, testid }) => {
  const dialogRef=useDialogFocus(open,Boolean(busy),onClose);
  const heading=useId();
  if(!open)return null;
  return (
    <div className={`modal-backdrop${open ? ' open' : ''}`} aria-hidden={!open} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} data-testid={testid}>
      <div ref={dialogRef} tabIndex={-1} className="modal-card" role="dialog" aria-modal="true" aria-labelledby={heading}>
        <div className="modal-header">
          <div className="modal-title" id={heading}><span>{title}</span></div>
          <button className="modal-close" type="button" aria-label="Close dialog" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="modal-body">
          {children}
          {error && <div className="field-error" style={{ fontSize: 12.5, marginTop: 10 }} data-testid="modal-error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          {onConfirm && <button className="modal-btn modal-btn-primary" type="button" onClick={onConfirm} disabled={busy} data-testid="modal-confirm">{busy ? 'Working…' : confirmLabel}</button>}
        </div>
      </div>
    </div>
  );
};

/** Bottom-right toast; `show(text)` displays it for a few seconds. */
export function useToast(): [React.ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(null), 4500);
    return () => clearTimeout(t);
  }, [text]);
  return [text ? <div className="toast" role="status" data-testid="toast">{text}</div> : null, setText];
}

export async function postJson(url: string, body: any): Promise<{ status: number; ok: boolean; data: any }> {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok && data.success !== false, data };
}

