import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let CACHED_LUA = '';
async function getLua() {
  if (CACHED_LUA) return CACHED_LUA;
  const r = await pool.query('SELECT lua FROM script WHERE id = 1');
  if (!r.rows[0]) throw new Error('no row');
  CACHED_LUA = r.rows[0].lua;
  return CACHED_LUA;
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++; hits.set(ip, rec);
  return rec.count > 30;
}

const VALID_TOKENS = new Map();
function mintToken(ip, ua) {
  const t = crypto.randomBytes(24).toString('hex');
  VALID_TOKENS.set(t, { ip, ua, exp: Date.now() + 300000 });
  setTimeout(() => VALID_TOKENS.delete(t), 300000);
  return t;
}
function consumeToken(t, ip, ua) {
  const e = VALID_TOKENS.get(t);
  if (!e) return false;
  if (Date.now() > e.exp || e.ip !== ip || e.ua !== ua) { VALID_TOKENS.delete(t); return false; }
  VALID_TOKENS.delete(t);
  return true;
}

function isExecutor(ua) {
  const u = (ua || '').toLowerCase();
  return ['roblox','synapse','krnl','delta','fluxus','argon','codex',
          'hydrogen','wave','solara','xeno','script-ware','swift'].some(k => u.includes(k));
}

app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (!isExecutor(ua)) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.type('text/plain').send(
    '-- use the mint flow\n' +
    'local t=game:HttpGet("https://YOUR-APP.up.railway.app/mint")\n' +
    'loadstring(game:HttpGet("https://YOUR-APP.up.railway.app/loader.lua?t="..t))()'
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/mint', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  if (rateLimited(ip)) return res.status(429).type('text/plain').send('-- slow down');
  if (!isExecutor(ua)) return res.status(403).type('text/plain').send('-- forbidden');
  res.type('text/plain').send(mintToken(ip, ua));
});

app.get('/loader.lua', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const token = req.query.t;
  if (rateLimited(ip)) return res.status(429).type('text/plain').send('-- slow down');
  if (!isExecutor(ua)) return res.status(403).type('text/plain').send('-- forbidden');
  if (!token || !consumeToken(token, ip, ua)) {
    return res.status(403).type('text/plain').send('-- forbidden');
  }
  let lua;
  try { lua = await getLua(); }
  catch (e) { console.error('db failed:', e.message); return res.status(502).type('text/plain').send('-- upstream error'); }
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive'
  });
  res.send(lua);
});

app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

app.listen(PORT, () => console.log(`loader up on ${PORT}`));
