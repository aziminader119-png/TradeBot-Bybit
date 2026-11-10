// Pure display formatting (no React), shared by components and offline tests.

const pad = (n: number) => String(n).padStart(2, '0');

/** MM/DD/YYYY + hh:mm:ss AM/PM (zero-padded), in the viewer's local time unless `utc`. null for missing / invalid. */
export function dateTimeParts(ts: unknown, utc = false): { date: string; time: string } | null {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' && ts.trim() !== '' ? Number(ts) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  const y = utc ? d.getUTCFullYear() : d.getFullYear(), mo = utc ? d.getUTCMonth() : d.getMonth(), da = utc ? d.getUTCDate() : d.getDate();
  const h = utc ? d.getUTCHours() : d.getHours(), mi = utc ? d.getUTCMinutes() : d.getMinutes(), s = utc ? d.getUTCSeconds() : d.getSeconds();
  return { date: `${pad(mo + 1)}/${pad(da)}/${y}`, time: `${pad(h % 12 || 12)}:${pad(mi)}:${pad(s)} ${h < 12 ? 'AM' : 'PM'}${utc ? ' UTC' : ''}` };
}

/** Position side (never the order side): Buy / Long → BUY, Sell / Short → SHORT. */
export function positionSide(side: unknown): 'BUY' | 'SHORT' | null {
  const s = String(side ?? '').toLowerCase();
  return s === 'buy' || s === 'long' ? 'BUY' : s === 'sell' || s === 'short' ? 'SHORT' : null;
}

export const leverageText = (lev: unknown) => (typeof lev === 'number' && Number.isFinite(lev) && lev > 0 ? `${Number(lev.toFixed(2))}x` : '—');

/** Sidebar count: "—" while loading / unavailable; integers, or compact thousands (500 → 0.500k, 1000 → 1k). */
export function formatCount(n: number | null | undefined, compact = false): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  const v = Math.trunc(n);
  if (!compact || v === 0) return String(v);
  return v % 1000 === 0 ? `${v / 1000}k` : `${(v / 1000).toFixed(3)}k`;
}
