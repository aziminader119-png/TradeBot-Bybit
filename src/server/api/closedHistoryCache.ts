import {createHash, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';

const DAY = 86400000, OVERLAP = 10 * 60000;
export type ClosedRow = {id: string; symbol: string; positionSide: string; qty: number; entryPrice: number; exitPrice: number; closedPnl: number; leverage: number | null; closedAt: number; owner: string};
type PageOptions = {startTime: number; endTime: number; limit: number; cursor?: string};
type Context = {scope: string; botOrders: Set<string>; readPage: (opts: PageOptions) => Promise<{list: any[]; nextPageCursor?: string}>};
export type ClosedHistoryResponse = {rows: ClosedRow[]; days: number; reset: boolean; cursor: string; windowStart: number; checkedAt: number; source: string};

// Fingerprint is never returned to the browser. Switching credentials/host/environment cannot reuse another account's cache.
export function closedAccountScope(settings: {apiKey: string; apiSecret: string; environment: string; apiHost?: string}) {
  return createHash('sha256').update(JSON.stringify([settings.apiKey, settings.apiSecret, settings.environment, settings.apiHost || 'api.bybit.com'])).digest('hex');
}
export function mapClosedRecord(c: any, botOrders: Set<string>): ClosedRow {
  const closedAt = Number(c.updatedTime || c.createdTime);
  if (!c.orderId || !c.createdTime || !Number.isFinite(closedAt)) throw Error('Invalid closed-P&L record returned by Bybit');
  return {id: `${c.orderId}|${c.createdTime}`, symbol: c.symbol, positionSide: c.side === 'Sell' ? 'Long' : 'Short',
    qty: Number(c.closedSize || c.qty || 0), entryPrice: Number(c.avgEntryPrice || 0), exitPrice: Number(c.avgExitPrice || 0),
    closedPnl: Number(c.closedPnl || 0), leverage: Number(c.leverage) || null, closedAt, owner: botOrders.has(c.orderId) ? 'Bot' : 'External'};
}

// Read-only reporting cache, separate from the trading database and its durable order journal.
export class ClosedHistoryCache {
  private scope = '';
  private nonce = randomUUID();
  private raw = new Map<string, any>();
  private rows = new Map<string, {row: ClosedRow; encoded: string; revision: number}>();
  private revision = 0;
  private coveredFrom = Infinity;
  private checkedAt = 0;
  private reconciledAt = 0;
  private attemptAt = 0;
  private lastError: Error | null = null;
  private inFlight: Promise<void> | null = null;
  private saved: Promise<void> = Promise.resolve();
  private loaded = false;
  private persistedAt = 0;
  constructor(private options: {context: () => Context; filePath?: string; now?: () => number; minRefreshMs?: number; onPersistenceError?: (e: unknown) => void}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private async init(ctx: Context) {
    if (this.scope === ctx.scope && this.loaded) return;
    this.scope = ctx.scope; this.nonce = randomUUID(); this.raw.clear(); this.rows.clear(); this.revision = 0;
    this.coveredFrom = Infinity; this.checkedAt = 0; this.reconciledAt = 0; this.attemptAt = 0; this.lastError = null; this.loaded = true;
    if (!this.options.filePath) return;
    try {
      const disk = JSON.parse(await fs.readFile(this.options.filePath, 'utf8'));
      if (disk.version !== 1 || disk.scope !== ctx.scope || !Array.isArray(disk.records) || !Number.isFinite(disk.coveredFrom) || !Number.isFinite(disk.checkedAt) || disk.checkedAt > this.now()) return;
      for (const record of disk.records) { const row = mapClosedRecord(record, ctx.botOrders); if (row.closedAt >= this.now() - 30 * DAY) this.raw.set(row.id, record); }
      this.coveredFrom = disk.coveredFrom; this.checkedAt = disk.checkedAt; this.reconciledAt = Number(disk.reconciledAt) || 0;
    } catch { /* Missing/corrupt cache is rebuilt with authenticated reads, never invented data. */ }
  }
  private async readRange(ctx: Context, start: number, end: number, staged: Map<string, any>, changes: {dirty: boolean}) {
    for (let to = end; to >= start; to -= 7 * DAY + 1) {
      const from = Math.max(start, to - 7 * DAY), cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 100) throw Error('Closed-P&L pagination exceeded 100 pages; cache was not advanced');
        const response = await ctx.readPage({startTime: from, endTime: to, limit: 100, cursor});
        if (!Array.isArray(response.list)) throw Error('Invalid closed-P&L page');
        for (const record of response.list) {
          const row = mapClosedRecord(record, ctx.botOrders), previous = staged.get(row.id);
          if (previous && Number(previous.updatedTime || previous.createdTime) > row.closedAt) continue;
          if (JSON.stringify(previous) !== JSON.stringify(record)) { staged.set(row.id, record); changes.dirty = true; }
        }
        cursor = response.nextPageCursor;
        if (!cursor) break;
        if (cursors.has(cursor)) throw Error('Bybit repeated a closed-P&L cursor; cache was not advanced');
        cursors.add(cursor);
      }
    }
  }
  private persist() {
    if (!this.options.filePath) return;
    const file = this.options.filePath, data = JSON.stringify({version: 1, scope: this.scope, coveredFrom: this.coveredFrom, checkedAt: this.checkedAt, reconciledAt: this.reconciledAt, records: [...this.raw.values()]});
    this.saved = this.saved.then(async () => {
      await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
      const temp = file + '.tmp';
      await fs.writeFile(temp, data, {mode: 0o600});
      await fs.rename(temp, file);
    }).catch(e => this.options.onPersistenceError?.(e));
  }
  async flush() { await this.saved; }
  private async update(days: number) {
    const ctx = this.options.context();
    await this.init(ctx);
    const end = this.now(), start = end - days * DAY;
    if (start >= this.coveredFrom && end - this.attemptAt < (this.options.minRefreshMs ?? 2000)) {
      if (this.lastError) throw this.lastError;
      return;
    }
    this.attemptAt = end;
    const staged = new Map(this.raw), changes = {dirty: false};
    const backfill = start < this.coveredFrom;
    const reconcile = this.checkedAt && end - this.reconciledAt >= 6 * 3600000;
    try {
      if (reconcile) await this.readRange(ctx, Math.max(end - 30 * DAY, Math.min(start, this.coveredFrom)), end, staged, changes);
      else if (start < this.coveredFrom) await this.readRange(ctx, start, Math.min(end, this.coveredFrom - 1), staged, changes);
      // Occasional reconciliation catches unusually delayed/older corrections; browsers still receive deltas only.
      // Always overlap recent reads: Bybit indexing and partial fills can update an existing record.
      if (this.checkedAt && !reconcile) await this.readRange(ctx, Math.max(start, this.checkedAt - OVERLAP), end, staged, changes);
      if (this.options.context().scope !== ctx.scope) throw Error('Bybit account changed during the history read; retry with the current account');
      for (const [id, record] of staged) if (Number(record.updatedTime || record.createdTime) < end - 30 * DAY) { staged.delete(id); changes.dirty = true; }
      this.raw = staged; this.coveredFrom = Math.min(start, this.coveredFrom); this.checkedAt = end; this.lastError = null;
      if (reconcile || !this.reconciledAt) this.reconciledAt = end;
      if (changes.dirty || backfill || reconcile || end - this.persistedAt >= 60000) { this.persistedAt = end; this.persist(); }
    } catch (e: any) { this.lastError = e instanceof Error ? e : Error(String(e)); throw this.lastError; }
  }
  async read(days: number, cursor?: string): Promise<ClosedHistoryResponse> {
    // One in-flight exchange read across all pages/tabs. A wider period backfills only its missing range.
    while (this.inFlight) await this.inFlight;
    const task = this.update(days); this.inFlight = task;
    try { await task; } finally { if (this.inFlight === task) this.inFlight = null; }
    const ctx = this.options.context();
    if (ctx.scope !== this.scope) throw Error('Bybit account changed; retry history');
    for (const [id, record] of this.raw) {
      const row = mapClosedRecord(record, ctx.botOrders), encoded = JSON.stringify(row), previous = this.rows.get(id);
      if (previous?.encoded !== encoded) this.rows.set(id, {row, encoded, revision: ++this.revision});
    }
    for (const id of this.rows.keys()) if (!this.raw.has(id)) this.rows.delete(id);
    const prefix = `${this.nonce}:${days}:`, version = cursor?.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN;
    const reset = !Number.isInteger(version) || version < 0 || version > this.revision;
    const windowStart = this.now() - days * DAY;
    const rows = [...this.rows.values()].filter(x => x.row.closedAt >= windowStart && (reset || x.revision > version)).map(x => x.row).sort((a,b) => b.closedAt - a.closedAt);
    return {rows, days, reset, cursor: prefix + this.revision, windowStart, checkedAt: this.checkedAt, source: 'Bybit /v5/position/closed-pnl'};
  }
}
