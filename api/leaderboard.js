import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

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
const SEASON = '3';
const BOARD = `cactusdash:s${SEASON}:board:sidewinder`;
const playerKey = key => `cactusdash:s${SEASON}:player:${key}`;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.'\u2019-]{0,15}$/u;
const cleanName = v => String(v || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim();
const nameKey = name => name.toLowerCase();
const RACERS = new Set(['biscuit', 'pepper', 'panther', 'mochi', 'blueberry', 'turbo', 'clementine', 'beast']);
const LAPS = 3;
const MIN_RACE_MS = 90000;
const MAX_RACE_MS = 900000;
const MIN_LAP_MS = 28000;
const SUBMITS_PER_WINDOW = 20;
const WINDOW_SECONDS = 600;

// Anti-cheat. Every race gets a ticket from the server when its countdown starts, so a submitted time can
// never be shorter than the real time that passed. The game also sends the route it drove (a position every
// half second), which has to go round the real track three times without beating the game's top speed.
const TICKET_TTL_SECONDS = 3600;
const TICKETS_PER_WINDOW = 40;
const NAMES_PER_IP_PER_DAY = 10;
const CLOCK_GRACE_MS = 2000;
const MAX_TICKET_LATE_MS = 30000;
const TRACE_STEP_MS = 500;
const MAX_SPEED_MPS = 55;
const MAX_PACE_MPS = 48;
const PACE_WINDOW_STEPS = 20;
const MAX_LATERAL_M = 40;
const FINISH_SLACK_M = 15;
const SPLIT_SLACK_MS = 1500;
// Names listed in the BANNED_NAMES setting (comma separated) are removed from the board and can't post.
const BANNED = new Set(String(process.env.BANNED_NAMES || '').split(',').map(v => nameKey(cleanName(v))).filter(Boolean));
let bannedSwept = false;
const ticketKey = id => `cactusdash:s${SEASON}:ticket:${id}`;
const NOT_VERIFIED = 'This run couldn\u2019t be verified, so it wasn\u2019t saved.';

// Track centre line: 280 evenly spaced points (x, z in decimetres), starting at the finish line.
const TRACK = '0,600,7,550,13,499,17,449,19,397,20,347,20,296,19,245,17,194,15,143,13,92,10,41,8,-10,5,-61,2,-111,0,-162,-1,-213,-2,-264,-2,-315,-1,-367,1,-418,3,-467,5,-518,6,-569,8,-620,9,-671,11,-722,14,-773,17,-824,20,-874,25,-925,31,-975,39,-1026,48,-1076,59,-1126,72,-1175,87,-1223,104,-1271,121,-1319,140,-1366,160,-1413,181,-1460,203,-1506,227,-1551,252,-1595,278,-1639,306,-1681,336,-1723,367,-1762,401,-1801,436,-1837,474,-1871,513,-1903,554,-1934,596,-1962,640,-1989,684,-2014,729,-2037,775,-2059,822,-2078,870,-2096,919,-2112,968,-2126,1017,-2137,1067,-2146,1117,-2152,1168,-2155,1219,-2156,1270,-2154,1321,-2150,1372,-2144,1422,-2136,1472,-2126,1521,-2114,1570,-2100,1619,-2085,1667,-2067,1713,-2046,1759,-2024,1803,-1998,1845,-1970,1886,-1940,1925,-1907,1963,-1873,1999,-1837,2033,-1799,2066,-1760,2096,-1719,2124,-1677,2150,-1633,2172,-1587,2190,-1539,2202,-1490,2203,-1439,2194,-1389,2178,-1341,2159,-1294,2137,-1247,2115,-1201,2094,-1155,2074,-1108,2058,-1060,2049,-1010,2049,-960,2061,-910,2084,-865,2114,-823,2147,-785,2182,-747,2218,-711,2254,-675,2290,-638,2324,-601,2355,-561,2381,-517,2397,-469,2399,-418,2386,-369,2364,-324,2336,-280,2306,-239,2275,-198,2244,-158,2214,-116,2187,-73,2165,-27,2152,21,2151,72,2159,123,2172,171,2190,219,2211,266,2234,311,2260,355,2288,398,2317,439,2348,480,2379,520,2413,559,2446,596,2483,632,2522,664,2564,693,2608,719,2652,744,2697,768,2743,791,2788,814,2833,837,2877,863,2920,889,2962,919,3001,951,3039,985,3077,1019,3115,1053,3152,1088,3189,1123,3225,1159,3260,1196,3293,1234,3326,1273,3357,1314,3385,1356,3410,1400,3432,1447,3448,1494,3460,1544,3468,1594,3472,1644,3474,1695,3473,1746,3469,1797,3463,1848,3455,1898,3443,1948,3429,1997,3411,2044,3389,2091,3362,2134,3330,2172,3292,2206,3250,2236,3207,2261,3161,2284,3114,2304,3066,2320,3017,2334,2967,2345,2916,2352,2865,2354,2815,2352,2765,2342,2717,2324,2673,2300,2630,2272,2590,2241,2552,2208,2515,2173,2479,2137,2443,2100,2409,2063,2374,2025,2339,1988,2308,1948,2281,1906,2255,1861,2232,1816,2209,1770,2186,1725,2163,1680,2138,1636,2109,1593,2077,1553,2039,1520,1994,1498,1944,1487,1893,1487,1843,1493,1793,1504,1744,1518,1696,1535,1648,1553,1601,1572,1554,1591,1507,1610,1459,1629,1411,1646,1364,1663,1317,1683,1271,1704,1226,1727,1181,1751,1136,1775,1091,1799,1045,1822,999,1844,952,1863,904,1880,855,1892,804,1900,754,1902,703,1901,652,1897,602,1891,551,1882,502,1870,453,1857,404,1841,356,1824,309,1804,263,1783,218,1760,174,1735,130,1709,87,1681,45,1652,4,1622,-36,1590,-74,1557,-111,1522,-146,1485,-178,1445,-207,1403,-231,1358,-247,1311,-255,1260,-252,1209,-241,1160,-224,1112,-204,1064,-182,1019,-159,974,-135,929,-111,884,-87,838,-65,792,-44,746,-26,698,-11,649'.split(',').map(Number);
const TRACK_LEN = 1425.322;
const TN = TRACK.length / 2, TDS = TRACK_LEN / TN;
const TX = [], TZ = [], TFX = [], TFZ = [];
for (let i = 0; i < TN; i++) { TX.push(TRACK[2 * i] / 10); TZ.push(TRACK[2 * i + 1] / 10); }
for (let i = 0; i < TN; i++) {
  const a = (i + TN - 1) % TN, b = (i + 1) % TN, fx = TX[b] - TX[a], fz = TZ[b] - TZ[a], l = Math.hypot(fx, fz);
  TFX.push(fx / l); TFZ.push(fz / l);
}

function nearestTrack(x, z, hint) {
  let best = Infinity, bi = hint < 0 ? 0 : hint;
  const scan = (from, to) => {
    for (let k = from; k <= to; k++) {
      const i = ((k % TN) + TN) % TN, dx = x - TX[i], dz = z - TZ[i], d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
  };
  if (hint < 0) { scan(0, TN - 1); return bi; }
  for (let n = 0, prev = -1; n < 40 && prev !== bi; n++) { prev = bi; scan(bi - 8, bi + 8); }
  return bi;
}

// Replays the submitted route the way the game counts laps. Returns a short reason when it doesn't hold up.
export function checkRoute(trace, timeMs, laps) {
  const n = trace.length / 2, expected = Math.floor(timeMs / TRACE_STEP_MS) + 2;
  if (!Number.isInteger(n) || n < expected - 1 || n > expected + 1) return 'samples';
  if (!trace.every(v => Number.isInteger(v) && Math.abs(v) < 100000)) return 'samples';
  const splits = [];
  laps.reduce((sum, l) => { splits.push(sum + l); return sum + l; }, 0);
  const crossings = [], steps = [];
  let hint = -1, prog = 0, lastS = 0, lapMax = 0, px = 0, pz = 0, pt = 0, pprog = 0;
  for (let k = 0; k < n; k++) {
    const x = trace[2 * k] / 10, z = trace[2 * k + 1] / 10;
    const t = k === n - 1 ? timeMs : Math.min(k * TRACE_STEP_MS, timeMs);
    const i = hint = nearestTrack(x, z, hint);
    const dx = x - TX[i], dz = z - TZ[i];
    const along = dx * TFX[i] + dz * TFZ[i], lat = dz * TFX[i] - dx * TFZ[i];
    if (Math.abs(lat) > MAX_LATERAL_M) return 'off track';
    const s = ((i * TDS + along) % TRACK_LEN + TRACK_LEN) % TRACK_LEN;
    if (k === 0) {
      prog = s > TRACK_LEN / 2 ? s - TRACK_LEN : s;
      lapMax = Math.floor(prog / TRACK_LEN);
    } else {
      const step = Math.hypot(x - px, z - pz);
      if (step > MAX_SPEED_MPS * ((t - pt) / 1000 + 0.1)) return 'speed';
      if (k < n - 1) steps.push(step);
      let ds = s - lastS;
      if (ds < -TRACK_LEN / 2) ds += TRACK_LEN; else if (ds > TRACK_LEN / 2) ds -= TRACK_LEN;
      prog += ds;
      while (Math.floor(prog / TRACK_LEN) > lapMax) {
        lapMax++;
        if (lapMax >= 1) crossings.push(pt + (lapMax * TRACK_LEN - pprog) / (prog - pprog) * (t - pt));
      }
    }
    px = x; pz = z; pt = t; pprog = prog; lastS = s;
  }
  for (let k = 0, sum = 0; k < steps.length; k++) {
    sum += steps[k] - (k >= PACE_WINDOW_STEPS ? steps[k - PACE_WINDOW_STEPS] : 0);
    if (k >= PACE_WINDOW_STEPS - 1 && sum > MAX_PACE_MPS * PACE_WINDOW_STEPS * TRACE_STEP_MS / 1000) return 'pace';
  }
  if (crossings.length === LAPS - 1 && prog >= LAPS * TRACK_LEN - FINISH_SLACK_M) crossings.push(timeMs);
  if (crossings.length < LAPS) return 'laps';
  for (let j = 0; j < LAPS; j++) if (Math.abs(crossings[j] - splits[j]) > SPLIT_SLACK_MS) return 'splits';
  return null;
}

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

// Counts a request in a 10-minute window. Any counter left without an expiry gets one, so limits can't stick.
async function countHit(key) {
  const [count, ttl] = await redis([['INCR', key], ['TTL', key]]);
  if (ttl < 0) await redis([['EXPIRE', key, String(WINDOW_SECONDS)]]);
  return count;
}

async function sweepBanned() {
  if (bannedSwept || !BANNED.size) return;
  await redis([['ZREM', BOARD, ...BANNED]]);
  bannedSwept = true;
}

async function topEntries(limit) {
  const [flat] = await redis([['ZRANGE', BOARD, '0', String(limit - 1), 'WITHSCORES']]);
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) rows.push({ key: flat[i], timeMs: Number(flat[i + 1]) });
  if (!rows.length) return [];
  const details = await redis(rows.map(r => ['HMGET', playerKey(r.key), 'handle', 'racer', 'device']));
  return rows.map((r, i) => ({ rank: i + 1, name: details[i][0] || r.key, racer: details[i][1] || null, device: details[i][2] || null, timeMs: r.timeMs }));
}

async function standing(key) {
  const [rank, score, [racer, device], total] = await redis([['ZRANK', BOARD, key], ['ZSCORE', BOARD, key], ['HMGET', playerKey(key), 'racer', 'device'], ['ZCARD', BOARD]]);
  return rank === null ? null : { rank: rank + 1, timeMs: Number(score), racer: racer || null, device: device || null, total };
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
    await sweepBanned();
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
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

      if (body.action === 'start') {
        const count = await countHit(`cactusdash:tickets:${ip}`);
        if (count > TICKETS_PER_WINDOW) return res.status(429).json({ error: 'Too many races started. Try again in a few minutes.' });
        const ticket = randomBytes(16).toString('hex');
        await redis([['SET', ticketKey(ticket), String(Date.now()), 'EX', String(TICKET_TTL_SECONDS)]]);
        return res.status(200).json({ ticket });
      }

      const name = cleanName(body.name || body.handle);
      const racer = String(body.racer || '').toLowerCase();
      const device = body.device === 'mobile' || body.device === 'desktop' ? body.device : '';
      const timeMs = Math.round(Number(body.timeMs));
      const laps = Array.isArray(body.laps) ? body.laps.map(n => Math.round(Number(n))) : [];
      const ticket = String(body.ticket || '');
      const trace = Array.isArray(body.trace) ? body.trace : null;
      const ticketAt = Math.min(MAX_TICKET_LATE_MS, Math.max(0, Math.round(Number(body.ticketAt) || 0)));
      if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Names are 1-16 letters, numbers, spaces or - _ . \'' });
      if (!RACERS.has(racer)) return res.status(400).json({ error: 'Unknown racer.' });
      if (BANNED.has(nameKey(name))) return res.status(403).json({ error: 'This name can\u2019t be used on the leaderboard.' });
      if (!(timeMs >= MIN_RACE_MS && timeMs <= MAX_RACE_MS)) return res.status(400).json({ error: `${NOT_VERIFIED} (time)` });
      const lapSum = laps.reduce((a, b) => a + b, 0);
      if (laps.length !== LAPS || laps.some(l => !(l >= MIN_LAP_MS)) || Math.abs(lapSum - timeMs) > 1500) {
        return res.status(400).json({ error: `${NOT_VERIFIED} (laps)` });
      }
      if (!trace) return res.status(400).json({ error: 'A new version of Cactus Dash is out. Refresh the page, then race again to get on the leaderboard.' });
      if (!/^[0-9a-f]{32}$/.test(ticket)) {
        return res.status(400).json({ error: 'The game couldn\u2019t reach the leaderboard at the start of this race, so the time couldn\u2019t be checked. Check your connection and race again.' });
      }
      const routeProblem = checkRoute(trace, timeMs, laps);
      if (routeProblem) return res.status(400).json({ error: `${NOT_VERIFIED} (${routeProblem})` });

      const count = await countHit(`cactusdash:ratelimit:${ip}`);
      if (count > SUBMITS_PER_WINDOW) return res.status(429).json({ error: 'Too many submissions. Try again in a few minutes.' });

      const key = nameKey(name);
      const namesKey = `cactusdash:s${SEASON}:ipnames:${ip}`;
      const [knownName, nameCount] = await redis([['SISMEMBER', namesKey, key], ['SCARD', namesKey]]);
      if (!knownName && nameCount >= NAMES_PER_IP_PER_DAY) {
        return res.status(429).json({ error: 'Too many different names from this connection today. Try again tomorrow.' });
      }

      // Each ticket can be used once. A retry of the same result (e.g. after a dropped response) is accepted.
      const claim = `${key}:${timeMs}`;
      const [startedAt, claimed, owner] = await redis([
        ['GET', ticketKey(ticket)],
        ['SET', `${ticketKey(ticket)}:claim`, claim, 'NX', 'EX', String(TICKET_TTL_SECONDS)],
        ['GET', `${ticketKey(ticket)}:claim`]
      ]);
      if (startedAt === null) return res.status(400).json({ error: 'This race took too long to verify, so it wasn\u2019t saved.' });
      if (claimed === null) {
        if (owner === claim) return res.status(200).json({ ok: true, improved: false, me: await standing(key) });
        return res.status(400).json({ error: 'This race was already submitted.' });
      }
      if (Date.now() - Number(startedAt) < timeMs - ticketAt - CLOCK_GRACE_MS) return res.status(400).json({ error: `${NOT_VERIFIED} (clock)` });

      if (!knownName) await redis([['SADD', namesKey, key], ['EXPIRE', namesKey, '86400']]);
      const [previous] = await redis([['ZSCORE', BOARD, key]]);
      const improved = previous === null || timeMs < Number(previous);
      const commands = [['HINCRBY', playerKey(key), 'races', '1']];
      if (improved) {
        commands.push(
          ['ZADD', BOARD, String(timeMs), key],
          ['HSET', playerKey(key), 'handle', name, 'racer', racer, 'device', device, 'timeMs', String(timeMs), 'at', new Date().toISOString()]
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
