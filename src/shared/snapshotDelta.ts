// Display transport only. Full snapshots remain supported for older frontends.
export type StateRecord = Record<string, any>;
export type SnapshotFrame = {type: 'SNAPSHOT'; data: StateRecord; version: number};
export type PatchFrame = {type: 'PATCH'; data: StateRecord; version: number; baseVersion: number; tickers?: {upsert: StateRecord; removed: string[]}};

export class SnapshotDelta {
  version = 0;
  private fields = new Map<string, string>();
  private tickers = new Map<string, string>();
  private snapshot = '';
  next(data: StateRecord): PatchFrame {
    const patch: PatchFrame = {type: 'PATCH', data: {}, baseVersion: this.version, version: ++this.version};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'tickers') continue;
      const encoded = JSON.stringify(value);
      if (this.fields.get(key) !== encoded) patch.data[key] = value;
      this.fields.set(key, encoded);
    }
    const upsert: StateRecord = {}, removed: string[] = [];
    const values = data.tickers || {};
    for (const [symbol, value] of Object.entries(values)) {
      const encoded = JSON.stringify(value);
      if (this.tickers.get(symbol) !== encoded) upsert[symbol] = value;
      this.tickers.set(symbol, encoded);
    }
    for (const symbol of this.tickers.keys()) if (!Object.hasOwn(values, symbol)) { removed.push(symbol); this.tickers.delete(symbol); }
    if (Object.keys(upsert).length || removed.length) patch.tickers = {upsert, removed};
    // Encoded values detach the baseline from mutable engine objects. Build a full frame only when needed.
    this.snapshot = '';
    return patch;
  }
  full(): string {
    if (!this.snapshot) {
      const fields = [...this.fields].filter(([, value]) => value !== undefined).map(([key, value]) => JSON.stringify(key) + ':' + value);
      const tickers = [...this.tickers].map(([key, value]) => JSON.stringify(key) + ':' + value).join(',');
      fields.push('"tickers":{' + tickers + '}');
      this.snapshot = '{"type":"SNAPSHOT","version":' + this.version + ',"data":{' + fields.join(',') + '}}';
    }
    return this.snapshot;
  }
}

export function applySnapshotPatch(previous: StateRecord, frame: PatchFrame): StateRecord {
  const next = {...previous, ...frame.data};
  if (frame.tickers) {
    next.tickers = {...previous.tickers, ...frame.tickers.upsert};
    for (const key of frame.tickers.removed) delete next.tickers[key];
  }
  return next;
}
