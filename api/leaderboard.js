import net from 'node:net';
import tls from 'node:tls';

function findEnv(names) {
  for (const n of names) if (process.env[n]) return [n, process.env[n]];
  for (const [k, v] of Object.entries(process.env)) if (v && names.some(n => k.endsWith('_' + n))) return [k, v];
  return [null, null];
}
function storageConfig() {
  const [urlVar, url] = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
  const [tokenVar, token] = findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);
  if (url && token) return { url: url.replace(/\/+$/, ''), token, source: `${urlVar} + ${tokenVar}` };
  const [redisVar, redisUrl] = findEnv(['REDIS_URL', 'KV_URL']);
  if (redisUrl && /^rediss?:\/\//.test(redisUrl)) return { redisUrl, source: redisVar };
  return null;
}
const STORAGE = storageConfig();

// Change SEASON to start a fresh leaderboard; earlier seasons stay in storage but are no longer read.
const SEASON = '2';
const BOARD = `cactusdash:s${SEASON}:board:sidewinder`;
const playerKey = key => `cactusdash:s${SEASON}:player:${key}`;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.'\u2019-]{0,15}$/u;
const cleanName = v => String(v || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim();
const nameKey = name => name.toLowerCase();
const RACERS = new Set(['biscuit', 'pepper', 'panther', 'mochi', 'clementine', 'beast']);
const LAPS = 3;
const MIN_RACE_MS = 80000;
const MAX_RACE_MS = 900000;
const MIN_LAP_MS = 25000;
const SUBMITS_PER_WINDOW = 20;
const WINDOW_SECONDS = 600;

async function redis(commands) {
  const replies = STORAGE.redisUrl ? await redisTcp(STORAGE.redisUrl, commands) : await redisRest(commands);
  return replies.map(r => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

async function redisRest(commands) {
  const res = await fetch(`${STORAGE.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORAGE.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Storage request failed (${res.status})`);
  return res.json();
}

// Plain Redis connection, for databases that only provide a REDIS_URL.
export function encodeCommand(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) { const v = String(a); out += `$${Buffer.byteLength(v)}\r\n${v}\r\n`; }
  return out;
}

export function parseReply(buf, pos) {
  if (pos >= buf.length) return null;
  const end = buf.indexOf('\r\n', pos);
  if (end < 0) return null;
  const type = String.fromCharCode(buf[pos]), line = buf.toString('utf8', pos + 1, end), next = end + 2;
  if (type === '+') return [{ result: line }, next];
  if (type === '-') return [{ error: line }, next];
  if (type === ':') return [{ result: Number(line) }, next];
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return [{ result: null }, next];
    if (buf.length < next + len + 2) return null;
    return [{ result: buf.toString('utf8', next, next + len) }, next + len + 2];
  }
  if (type === '*') {
    const count = Number(line);
    if (count < 0) return [{ result: null }, next];
    const items = [];
    let p = next;
    for (let k = 0; k < count; k++) {
      const item = parseReply(buf, p);
      if (!item) return null;
      if (item[0].error) return [{ error: item[0].error }, item[1]];
      items.push(item[0].result);
      p = item[1];
    }
    return [{ result: items }, p];
  }
  throw new Error('Unexpected reply from storage');
}

function redisTcp(redisUrl, commands) {
  const u = new URL(redisUrl);
  const pre = [];
  if (u.password) pre.push(u.username ? ['AUTH', decodeURIComponent(u.username), decodeURIComponent(u.password)] : ['AUTH', decodeURIComponent(u.password)]);
  const db = u.pathname.replace('/', '');
  if (/^\d+$/.test(db) && db !== '0') pre.push(['SELECT', db]);
  const all = pre.concat(commands);
  return new Promise((resolve, reject) => {
    const opts = { host: u.hostname, port: Number(u.port) || 6379 };
    const sock = u.protocol === 'rediss:' ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
    let buf = Buffer.alloc(0), pos = 0;
    const replies = [];
    const fail = err => { sock.destroy(); reject(err); };
    sock.setTimeout(8000, () => fail(new Error('Storage connection timed out')));
    sock.on('error', err => fail(new Error(`Storage connection failed: ${err.message}`)));
    sock.on('close', () => { if (replies.length < all.length) reject(new Error('Storage closed the connection')); });
    sock.write(all.map(encodeCommand).join(''));
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      try {
        let item;
        while (replies.length < all.length && (item = parseReply(buf, pos))) { replies.push(item[0]); pos = item[1]; }
      } catch (err) { return fail(err); }
      if (replies.length === all.length) {
        sock.end();
        const auth = replies.slice(0, pre.length).find(r => r.error);
        if (auth) return reject(new Error(auth.error));
        resolve(replies.slice(pre.length));
      }
    });
  });
}

async function topEntries(limit) {
  const [flat] = await redis([['ZRANGE', BOARD, '0', String(limit - 1), 'WITHSCORES']]);
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) rows.push({ key: flat[i], timeMs: Number(flat[i + 1]) });
  if (!rows.length) return [];
  const details = await redis(rows.map(r => ['HMGET', playerKey(r.key), 'handle', 'racer']));
  return rows.map((r, i) => ({ rank: i + 1, name: details[i][0] || r.key, racer: details[i][1] || null, timeMs: r.timeMs }));
}

async function standing(key) {
  const [rank, score, racer, total] = await redis([['ZRANK', BOARD, key], ['ZSCORE', BOARD, key], ['HGET', playerKey(key), 'racer'], ['ZCARD', BOARD]]);
  return rank === null ? null : { rank: rank + 1, timeMs: Number(score), racer: racer || null, total };
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.query && req.query.health !== undefined) {
    const storageVars = Object.keys(process.env).filter(k => /KV_|UPSTASH|REDIS/.test(k)).sort();
    if (!STORAGE) return res.status(200).json({ ok: false, problem: 'No storage connection found. In Vercel open Storage, connect an Upstash (Redis) database to this project, then redeploy.', storageVars });
    try {
      const [pong, total] = await redis([['PING'], ['ZCARD', BOARD]]);
      return res.status(200).json({ ok: pong === 'PONG', season: SEASON, racersOnBoard: total, usingVars: STORAGE.source, storageVars });
    } catch (err) {
      return res.status(200).json({ ok: false, problem: `Storage found (${STORAGE.source}) but it rejected the request: ${err.message}`, storageVars });
    }
  }
  if (!STORAGE) return res.status(503).json({ error: 'Leaderboard storage is not connected yet.' });
  try {
    if (req.method === 'GET') {
      const name = cleanName(req.query && (req.query.name || req.query.handle));
      const [entries, [total], me] = await Promise.all([
        topEntries(10),
        redis([['ZCARD', BOARD]]),
        NAME_RE.test(name) ? standing(nameKey(name)) : null
      ]);
      return res.status(200).json({ entries, total, me });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const name = cleanName(body.name || body.handle);
      const racer = String(body.racer || '').toLowerCase();
      const timeMs = Math.round(Number(body.timeMs));
      const laps = Array.isArray(body.laps) ? body.laps.map(n => Math.round(Number(n))) : [];
      if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Names are 1-16 letters, numbers, spaces or - _ . \'' });
      if (!RACERS.has(racer)) return res.status(400).json({ error: 'Unknown racer.' });
      if (!(timeMs >= MIN_RACE_MS && timeMs <= MAX_RACE_MS)) return res.status(400).json({ error: 'Race time is out of range.' });
      const lapSum = laps.reduce((a, b) => a + b, 0);
      if (laps.length !== LAPS || laps.some(l => !(l >= MIN_LAP_MS)) || Math.abs(lapSum - timeMs) > 1500) {
        return res.status(400).json({ error: 'Lap times do not add up to the race time.' });
      }

      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const limitKey = `cactusdash:ratelimit:${ip}`;
      const [count] = await redis([['INCR', limitKey]]);
      if (count === 1) await redis([['EXPIRE', limitKey, String(WINDOW_SECONDS)]]);
      if (count > SUBMITS_PER_WINDOW) return res.status(429).json({ error: 'Too many submissions. Try again in a few minutes.' });

      const key = nameKey(name);
      const [previous] = await redis([['ZSCORE', BOARD, key]]);
      const improved = previous === null || timeMs < Number(previous);
      const commands = [['HINCRBY', playerKey(key), 'races', '1']];
      if (improved) {
        commands.push(
          ['ZADD', BOARD, String(timeMs), key],
          ['HSET', playerKey(key), 'handle', name, 'racer', racer, 'timeMs', String(timeMs), 'at', new Date().toISOString()]
        );
      }
      await redis(commands);
      return res.status(200).json({ ok: true, improved, me: await standing(key) });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Leaderboard is unavailable right now.' });
  }
}
