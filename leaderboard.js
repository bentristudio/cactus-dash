const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const BOARD = 'cactusdash:board:sidewinder';
const playerKey = key => `cactusdash:player:${key}`;
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
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Storage request failed (${res.status})`);
  const out = await res.json();
  return out.map(r => {
    if (r.error) throw new Error(r.error);
    return r.result;
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
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'Leaderboard storage is not connected yet.' });
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
