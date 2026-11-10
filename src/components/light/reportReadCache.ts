// Shared per-tab private reads. Account data is never stored in localStorage or a public HTTP cache.
export type ReadEntry = {data: any; error: string | null; loading: boolean; at: number; cursor?: string; signature?: string; busy: Promise<void> | null; controller?: AbortController; generation: number};
export class ReportReadCache {
  readonly entries = new Map<string, ReadEntry>();
  constructor(private fetcher: typeof fetch = (input, init) => fetch(input, init), private notify: (url: string) => void = () => {}) {}
  entry(url: string) {
    let entry = this.entries.get(url);
    if (!entry) { entry = {data: null, error: null, loading: false, at: 0, busy: null, generation: 0}; this.entries.set(url, entry); }
    return entry;
  }
  async load(url: string) {
    const entry = this.entry(url);
    if (entry.busy) return entry.busy; // All subscribers share the same in-flight promise, without redundant follow-up requests.
    const generation = entry.generation, controller = new AbortController();
    entry.controller = controller; entry.loading = true;
    if (!entry.data) this.notify(url);
    const task = Promise.resolve().then(async () => {
      try {
        const incremental = url.startsWith('/api/closed-positions?');
        const request = incremental && entry.cursor ? url + '&cursor=' + encodeURIComponent(entry.cursor) : url;
        const response = await this.fetcher.call(globalThis, request, {signal: controller.signal, cache: 'no-store'});
        let data = await response.json();
        if (generation !== entry.generation) return;
        if (!response.ok || data.error) {
          if (response.status === 401 || response.status === 403 || response.status === 409) { entry.data = null; entry.cursor = undefined; entry.signature = undefined; }
          throw Error(data.error || 'HTTP ' + response.status);
        }
        if (incremental && typeof data.cursor === 'string') {
          if (!Array.isArray(data.rows)) throw Error('Invalid closed-position response');
          const rows = new Map<string, any>(data.reset === false && entry.data ? entry.data.rows.map((row: any) => [row.id, row]) : []);
          for (const row of data.rows) rows.set(row.id, row);
          for (const [id, row] of rows) if (Number.isFinite(data.windowStart) && row.closedAt < data.windowStart) rows.delete(id);
          entry.cursor = data.cursor;
          data = {...data, rows: [...rows.values()].sort((a,b) => b.closedAt - a.closedAt)};
        } else entry.cursor = undefined; // Older server: safely accept full responses.
        const {checkedAt, windowStart, cursor, reset, ...content} = data;
        const signature = JSON.stringify(content);
        if (signature !== entry.signature) { entry.data = data; entry.signature = signature; }
        entry.error = null;
      } catch (error: any) {
        if (generation === entry.generation && !controller.signal.aborted) entry.error = error.message || 'Read failed';
      } finally {
        if (generation === entry.generation) { entry.loading = false; entry.at = Date.now(); entry.busy = null; this.notify(url); }
      }
    });
    entry.busy = task;
    return task;
  }
  reset() {
    for (const [url, entry] of this.entries) {
      entry.generation++; entry.controller?.abort(); entry.data = null; entry.signature = undefined; entry.cursor = undefined;
      entry.busy = null; entry.at = 0; entry.loading = false; entry.error = null; this.notify(url);
    }
  }
  remove(url: string) { const entry = this.entries.get(url); if (entry) { entry.generation++; entry.controller?.abort(); this.entries.delete(url); } }
}
