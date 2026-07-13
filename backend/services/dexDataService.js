/**
 * dexDataService — GeckoTerminal (keyless, 30 calls/min) + DexScreener (keyless).
 *
 * GeckoTerminal is the single biggest free unlock in the stack: real pool
 * reserves, OHLCV, trending/new pools, and per-pool trades — all without a key.
 * It is what makes genuine liquidity intelligence possible on $0.
 */
import { get } from '../lib/http.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';

/** Every pool trading a token, deepest first. */
export async function fetchTokenPools(network, tokenAddress) {
  try {
    const d = await get('geckoterminal', `${GT}/networks/${network}/tokens/${tokenAddress}/pools?page=1`);
    const pools = (d?.data || []).map((p) => ({
      address: p.attributes?.address,
      name: p.attributes?.name,
      dex: p.relationships?.dex?.data?.id,
      reserve_usd: Number(p.attributes?.reserve_in_usd || 0),
      volume_24h: Number(p.attributes?.volume_usd?.h24 || 0),
      price_change_24h: Number(p.attributes?.price_change_percentage?.h24 || 0),
      created_at: p.attributes?.pool_created_at || null,
    })).sort((a, b) => b.reserve_usd - a.reserve_usd);
    return envelope(pools, { status: STATUS.LIVE, source: 'GeckoTerminal' });
  } catch {
    return unavailable('GeckoTerminal', 'Pool data could not be retrieved for this token.');
  }
}

/** Pool OHLCV — used for the 7d liquidity/price divergence read. */
export async function fetchPoolOhlcv(network, poolAddress, timeframe = 'day', limit = 8) {
  try {
    const d = await get('geckoterminal', `${GT}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?limit=${limit}`);
    return envelope(d?.data?.attributes?.ohlcv_list || [], { status: STATUS.LIVE, source: 'GeckoTerminal' });
  } catch {
    return unavailable('GeckoTerminal', 'OHLCV unavailable for this pool.');
  }
}

/**
 * Recent trades on a pool, including the buyer address.
 * This is the raw feed the ChainQuant smart-money proxy index is built from:
 * we record who buys early into pools that later run, and score wallets on our
 * own observed history. It is OUR index — not a licensed label from anyone else.
 */
export async function fetchPoolTrades(network, poolAddress) {
  try {
    const d = await get('geckoterminal', `${GT}/networks/${network}/pools/${poolAddress}/trades`);
    const trades = (d?.data || []).map((t) => ({
      tx_hash: t.attributes?.tx_hash,
      wallet: t.attributes?.tx_from_address,
      kind: t.attributes?.kind, // 'buy' | 'sell'
      volume_usd: Number(t.attributes?.volume_in_usd || 0),
      at: t.attributes?.block_timestamp,
    })).filter((t) => t.wallet);
    return envelope(trades, { status: STATUS.LIVE, source: 'GeckoTerminal' });
  } catch {
    return unavailable('GeckoTerminal', 'Trade feed unavailable for this pool.');
  }
}

export async function fetchTrendingPools(network = 'eth') {
  try {
    const d = await get('geckoterminal', `${GT}/networks/${network}/trending_pools`);
    return envelope(d?.data || [], { status: STATUS.LIVE, source: 'GeckoTerminal' });
  } catch {
    return unavailable('GeckoTerminal', 'Trending pools unavailable.');
  }
}

export async function fetchDexScreenerToken(tokenAddress) {
  try {
    const d = await get('dexscreener', `${DS}/latest/dex/tokens/${tokenAddress}`);
    return envelope(d?.pairs || [], { status: STATUS.LIVE, source: 'DexScreener' });
  } catch {
    return unavailable('DexScreener', 'Pair data unavailable.');
  }
}
