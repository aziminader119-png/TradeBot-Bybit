import fs from 'fs';
import path from 'path';

// Phase 1: only one engine process may run against a data directory. A second process exits
// BEFORE any Bybit request, so two instances can never send duplicate orders.
export function acquireInstanceLock(dataDir: string = path.resolve(process.cwd(), 'data')): { ok: true; release: () => void } | { ok: false; reason: string } {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'engine.lock');
  const tryCreate = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    tryCreate();
  } catch (err: any) {
    if (err.code !== 'EEXIST') return { ok: false, reason: `Cannot create lock file: ${err.message}` };
    const pid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    let alive = false;
    if (pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); alive = true; } catch (e: any) { alive = e.code === 'EPERM'; }
    }
    if (alive) return { ok: false, reason: `Another TradeBot instance (pid ${pid}) is already running on ${dataDir}` };
    fs.unlinkSync(lockPath); // stale lock from a crashed process
    try { tryCreate(); } catch (e: any) { return { ok: false, reason: `Lock race: ${e.message}` }; }
  }
  return {
    ok: true,
    release: () => {
      try {
        if (fs.readFileSync(lockPath, 'utf-8') === String(process.pid)) fs.unlinkSync(lockPath);
      } catch { /* already gone */ }
    },
  };
}
