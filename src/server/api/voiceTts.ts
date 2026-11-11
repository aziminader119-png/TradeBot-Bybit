import { Router } from 'express';
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Authenticated preview/notification synthesis only. Never places an order. */
export const voiceTtsRouter = Router();
const VOICES = new Set(['fa-IR-DilaraNeural', 'fa-IR-FaridNeural', 'en-US-JennyNeural', 'en-US-GuyNeural']);
const cache = new Map<string, Buffer>();
let active = 0;
const MAX_ACTIVE = 2;
const MAX_TEXT = 240;

function synthesize(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const interpreter = process.env.TRADEBOT_TTS_PYTHON || path.resolve(process.cwd(), '.venv-tts/bin/python');
    if (!existsSync(interpreter)) return reject(new Error('Speech engine not installed on server'));
    const output = path.join(tmpdir(), `tb-tts-${crypto.randomUUID()}.mp3`);
    const child = spawn(interpreter, ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', output],
      { stdio: 'ignore', shell: false });
    let settled = false;
    const finish = async (problem?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timeout);
      try {
        if (problem) throw problem;
        const data = await fs.readFile(output);
        if (data.length < 100 || data.length > 2_000_000) throw Error('Invalid speech output');
        resolve(data);
      } catch (error) { reject(error); }
      finally { void fs.unlink(output).catch(() => {}); }
    };
    const timeout = setTimeout(() => { child.kill('SIGKILL'); void finish(Error('Speech generation timed out')); }, 15_000);
    child.on('error', error => { void finish(error); });
    child.on('close', code => { void finish(code === 0 ? undefined : Error('Speech service unavailable')); });
  });
}

voiceTtsRouter.post('/', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const voice = String(req.body?.voice || 'fa-IR-DilaraNeural');
  if (!text || text.length > MAX_TEXT || !VOICES.has(voice) || /[\u0000-\u001f]/.test(text))
    return res.status(400).json({ error: 'Invalid speech request' });
  const key = crypto.createHash('sha256').update(`${voice}\0${text}`).digest('hex');
  const cached = cache.get(key);
  if (cached) { res.type('audio/mpeg').set('Cache-Control', 'private, no-store'); return res.send(cached); }
  if (active >= MAX_ACTIVE) return res.status(429).json({ error: 'Speech generator busy' });
  active++;
  try {
    const data = await synthesize(text, voice);
    if (cache.size >= 80) cache.delete(cache.keys().next().value!);
    cache.set(key, data);
    res.type('audio/mpeg').set('Cache-Control', 'private, no-store');
    return res.send(data);
  } catch (error) {
    console.warn('[TTS] unavailable:', (error as Error).message);
    return res.status(503).json({ error: 'Persian speech service is unavailable; check server TTS installation and outbound connectivity' });
  } finally { active--; }
});
