/**
 * marketDataService — CoinGecko.
 * Free tier: keyless public API. Paid tier: same endpoints on pro-api with a key.
 * Switching tiers is a base URL + header change. No call sites change.
 */
import { get } from '../lib/http.js';
import { envelope, STATUS } from '../lib/envelope.js';

const KEY = process.env.COINGECKO_API_KEY || '';
const TIER = KEY ? 'paid' : 'free';
const BASE = KEY ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
const HEADERS = KEY ? { 'x-cg-pro-api-key': KEY } : {};

export const tier = () => TIER;

export async function fetchMarkets(ids) {
  const url = `${BASE}/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=7d`;
  const data = await get('coingecko', url, { headers: HEADERS });
  return envelope(data, { status: STATUS.LIVE, source: `CoinGecko (${TIER})` });
}

export async function fetchTrending() {
  const data = await get('coingecko', `${BASE}/search/trending`, { headers: HEADERS });
  const ids = (data?.coins || []).map((c) => c.item?.id).filter(Boolean);
  return envelope(ids, { status: STATUS.LIVE, source: `CoinGecko (${TIER})` });
}

export async function fetchGlobal() {
  const data = await get('coingecko', `${BASE}/global`, { headers: HEADERS });
  return envelope(data?.data || null, { status: STATUS.LIVE, source: `CoinGecko (${TIER})` });
}

/** Category market data — the raw material for narrative market-share and rotation. */
export async function fetchCategories() {
  const data = await get('coingecko', `${BASE}/coins/categories`, { headers: HEADERS });
  return envelope(data, { status: STATUS.LIVE, source: `CoinGecko (${TIER})` });
}
