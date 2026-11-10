import React, { useMemo, useState } from 'react';
import { FilterChoices } from './FilterChoices.tsx';

// Shared pieces of the light list pages (Symbols, BOT Positions): sortable headers, rows-per-page, pagination.

export type SortDir = 'asc' | 'desc';
export type SortState<K extends string> = { key: K | null; dir: SortDir };

/** Click a header once = ascending, again = descending, a third time = back to the default order. */
export function useSort<K extends string>(): [SortState<K>, (k: K) => void] {
  const [s, setS] = useState<SortState<K>>({ key: null, dir: 'asc' });
  const toggle = (k: K) => setS((p) => (p.key !== k ? { key: k, dir: 'asc' } : p.dir === 'asc' ? { key: k, dir: 'desc' } : { key: null, dir: 'asc' }));
  return [s, toggle];
}

/** Sort with missing values (null / undefined / NaN) always last, in both directions. */
export function sortRows<T, K extends string>(rows: T[], s: SortState<K>, get: (r: T, k: K) => number | string | null | undefined): T[] {
  if (!s.key) return rows;
  const k = s.key;
  const m = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a, k), y = get(b, k);
    const xn = x === null || x === undefined || (typeof x === 'number' && !Number.isFinite(x));
    const yn = y === null || y === undefined || (typeof y === 'number' && !Number.isFinite(y));
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
    return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number)) * m;
  });
}

export const SortTh: React.FC<{ k: string; s: SortState<any>; onSort: (k: any) => void; children: React.ReactNode; className?: string; title?: string }> = ({ k, s, onSort, children, className, title }) => (
  <th className={`sort${className ? ' ' + className : ''}${s.key === k ? ' sorted' : ''}`} data-sort={k} title={title} aria-sort={s.key === k ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSort(k);}}} onClick={() => onSort(k)}>
    {children} <span className="sort-ind" aria-hidden="true">{s.key === k ? (s.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
  </th>
);

export const ROW_SIZES = [20, 50, 75, 100];

export const RowsPicker: React.FC<{ size: number; onSize: (n: number) => void }> = ({ size, onSize }) => (
  <FilterChoices label="Rows:" className="tb-center" testId="rows-picker" optionAttribute="data-rows" value={size} options={ROW_SIZES.map(n=>({value:n,label:String(n)}))} onChange={onSize}/>
);

export function usePaged<T>(rows: T[], size: number, page: number) {
  return useMemo(() => {
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const p = Math.min(Math.max(1, page), pages);
    return { pages, page: p, slice: rows.slice((p - 1) * size, p * size), from: rows.length ? (p - 1) * size + 1 : 0, to: Math.min(p * size, rows.length) };
  }, [rows, size, page]);
}

export const Pager: React.FC<{ from: number; to: number; total: number; page: number; pages: number; noun: string; onPage: (p: number) => void }> = (p) => (
  <div className="list-footer" data-testid="pager">
    <span data-testid="range">{p.from}–{p.to} of {p.total} {p.noun}</span>
    <div className="pagination">
      <button type="button" disabled={p.page <= 1} onClick={() => p.onPage(p.page - 1)} data-testid="prev">Previous</button>
      <span className="pg" data-testid="pages">Page {p.page} of {p.pages}</span>
      <button type="button" disabled={p.page >= p.pages} onClick={() => p.onPage(p.page + 1)} data-testid="next">Next</button>
    </div>
  </div>
);

export const num = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
/** price with as many decimals as the magnitude needs (as in the design) */
export const price = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v.toLocaleString('en-US', { maximumFractionDigits: v >= 10 ? 3 : v >= 1 ? 5 : 8 }) : '—');
export const signedPct = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
export const tone = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? 'green' : typeof v === 'number' && v < 0 ? 'red' : '');

