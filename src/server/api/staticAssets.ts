import type {IncomingMessage, ServerResponse} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {brotliCompress, gzip, constants} from 'node:zlib';
import {promisify} from 'node:util';
const brotli = promisify(brotliCompress), zip = promisify(gzip);
type Asset = {body: Buffer; tag: string; stamp: string};

// Only public Vite-hashed JS/CSS. Private APIs, HTML, range requests and trading data never enter this cache.
export function compressedAssets(root: string) {
  const cache = new Map<string, Asset>(), pending = new Map<string, Promise<Asset>>();
  const accepted = (value: string, encoding: string) => value.split(',').some(part => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.find(p => p.trim().startsWith('q='));
    return name === encoding && (!quality || Number(quality.trim().slice(2)) > 0);
  });
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const file = (req.url || '').split('?')[0].replace(/^\//, '');
    if (!/^[\w.-]+-[\w-]{6,}\.(js|css)$/.test(file) || !['GET', 'HEAD'].includes(req.method || '') || req.headers.range) { next(); return; }
    res.setHeader('Vary', 'Accept-Encoding');
    const accepts = String(req.headers['accept-encoding'] || '');
    const encoding = accepted(accepts, 'br') ? 'br' : accepted(accepts, 'gzip') ? 'gzip' : null;
    if (!encoding) { next(); return; }
    void (async () => {
      const location = path.join(root, file), stat = await fs.stat(location), stamp = `${stat.size}:${stat.mtimeMs}`, key = `${file}:${encoding}`;
      if (!stat.isFile() || stat.size < 1024 || stat.size > 4 * 1024 * 1024) { next(); return; }
      let asset = cache.get(key);
      if (!asset || asset.stamp !== stamp) {
        let work = pending.get(key);
        if (!work && pending.size >= 4) { next(); return; }
        if (!work) {
          work = (async () => {
            const raw = await fs.readFile(location);
            const body = encoding === 'br' ? await brotli(raw, {params: {[constants.BROTLI_PARAM_QUALITY]: 4}}) : await zip(raw);
            const built = {body, stamp, tag: '"' + createHash('sha256').update(body).digest('hex') + '"'};
            // Bound memory across hot updates and rollback assets.
            while (cache.size && (cache.size >= 24 || [...cache.values()].reduce((total, item) => total + item.body.length, 0) + body.length > 8 * 1024 * 1024)) cache.delete(cache.keys().next().value!);
            cache.set(key, built); return built;
          })();
          pending.set(key, work);
        }
        try { asset = await work; } finally { pending.delete(key); }
      }
      if (res.destroyed) return;
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('ETag', asset.tag);
      const tags = String(req.headers['if-none-match'] || '').split(',').map(x => x.trim().replace(/^W\//, ''));
      if (tags.includes(asset.tag) || tags.includes('*')) { res.statusCode = 304; res.end(); return; }
      res.setHeader('Content-Length', asset.body.length);
      res.end(req.method === 'HEAD' ? undefined : asset.body);
    })().catch(() => { if (!res.headersSent && !res.destroyed) next(); });
  };
}
