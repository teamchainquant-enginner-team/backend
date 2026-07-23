/**
 * ohlcService — candle proxy for the report chart.
 *
 * The browser never calls an exchange. It asks this API for /api/ohlc/:id?tf=,
 * and we fetch candles server-side from GeckoTerminal's pool OHLCV feed (free,
 * keyless, already rate-bucketed in lib/http). GeckoTerminal natively supports
 * minute{1,5,15}, hour{1,4,12}, day{1}; the ladder's other steps (30m, 3h, 6h,
 * 3d, 7d) are aggregated server-side from the nearest finer base. If an asset has
 * no resolvable DEX pool, we return UNAVAILABLE — we do not draw a fake chart.
 */
import { get } from '../lib/http.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

const GT = 'https://api.geckoterminal.com/api/v2';
const CG = 'https://api.coingecko.com/api/v3';

// CoinGecko platform key -> GeckoTerminal network id
const NET = {
  ethereum: 'eth', 'polygon-pos': 'polygon_pos', 'arbitrum-one': 'arbitrum',
  'optimistic-ethereum': 'optimism', base: 'base', 'binance-smart-chain': 'bsc',
  solana: 'solana', avalanche: 'avax',
};

// ladder id -> { base granularity + aggregate GT accepts, target bucket seconds }
const TF = {
  '5m':  { base: 'minute', agg: 5,  bucket: 300 },
  '15m': { base: 'minute', agg: 15, bucket: 900 },
  '30m': { base: 'minute', agg: 15, bucket: 1800 },
  '1h':  { base: 'hour',   agg: 1,  bucket: 3600 },
  '3h':  { base: 'hour',   agg: 1,  bucket: 10800 },
  '6h':  { base: 'hour',   agg: 1,  bucket: 21600 },
  '12h': { base: 'hour',   agg: 12, bucket: 43200 },
  '1d':  { base: 'day',    agg: 1,  bucket: 86400 },
  '3d':  { base: 'day',    agg: 1,  bucket: 259200 },
  '1w':  { base: 'day',    agg: 1,  bucket: 604800 },
};

// in-process TTL cache (kept out of cache_snapshots so it never serves stale
// candles and never bloats the shared snapshot table)
const mem = new Map();
const memGet = (k) => { const h = mem.get(k); return h && h.exp > Date.now() ? h.v : null; };
const memSet = (k, v, ttlMs) => mem.set(k, { v, exp: Date.now() + ttlMs });

async function resolvePool(id) {
  const ck = `pool:${id}`;
  const cached = memGet(ck);
  if (cached) return cached;
  let result = { none: true };
  try {
    const coin = await get('coingecko',
      `${CG}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
    const platforms = coin?.platforms || {};
    for (const [cgKey, addr] of Object.entries(platforms)) {
      const net = NET[cgKey];
      if (!net || !addr) continue;
      try {
        const pools = await get('geckoterminal', `${GT}/networks/${net}/tokens/${addr}/pools?page=1`);
        const top = pools?.data?.[0]?.attributes?.address;
        if (top) { result = { network: net, pool: top }; break; }
      } catch { /* try next platform */ }
    }
  } catch { /* id not found on CoinGecko */ }
  memSet(ck, result, 6 * 3600 * 1000); // pools rarely change
  return result;
}

// bucket finer candles into target seconds (open=first, close=last, high/low/vol accumulate)
function rebucket(rows, secs) {
  const out = [], map = new Map();
  for (const r of rows) {
    const b = Math.floor(r.time / secs) * secs;
    let g = map.get(b);
    if (!g) { g = { time: b, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }; map.set(b, g); out.push(g); }
    else { g.high = Math.max(g.high, r.high); g.low = Math.min(g.low, r.low); g.close = r.close; g.volume += r.volume; }
  }
  return out.sort((a, b) => a.time - b.time);
}

export async function ohlc(id, tfId = '1h') {
  const tf = TF[tfId];
  if (!tf) return unavailable('ChainQuant OHLC', `Unknown timeframe "${tfId}".`);
  const ck = `ohlc:${id}:${tfId}`;
  const hit = memGet(ck);
  if (hit) return hit;

  const p = await resolvePool(id);
  if (p.none) {
    const res = unavailable('GeckoTerminal', 'No DEX pool is indexed for this asset, so candles cannot be shown. Nothing is drawn rather than inventing a chart.');
    memSet(ck, res, 5 * 60 * 1000);
    return res;
  }

  try {
    const url = `${GT}/networks/${p.network}/pools/${p.pool}/ohlcv/${tf.base}?aggregate=${tf.agg}&limit=1000&currency=usd`;
    const raw = await get('geckoterminal', url);
    const list = raw?.data?.attributes?.ohlcv_list || [];
    let rows = list.map((x) => ({ time: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }))
      .sort((a, b) => a.time - b.time);
    // aggregate to the exact ladder bucket when GT's native step is finer
    const nativeStep = tf.base === 'minute' ? tf.agg * 60 : tf.base === 'hour' ? tf.agg * 3600 : 86400;
    if (tf.bucket > nativeStep) rows = rebucket(rows, tf.bucket);
    if (!rows.length) {
      const res = unavailable('GeckoTerminal', 'The pool returned no candles for this timeframe yet.');
      memSet(ck, res, 60 * 1000);
      return res;
    }
    const res = envelope(rows, {
      status: STATUS.DELAYED, source: 'GeckoTerminal pool OHLCV',
      note: `Candles from the primary ${p.network} DEX pool, cached ~45s. Timeframe ${tfId}.`,
    });
    memSet(ck, res, 45 * 1000);
    return res;
  } catch (e) {
    return unavailable('GeckoTerminal', 'Candle feed is temporarily unavailable for this asset.');
  }
}
