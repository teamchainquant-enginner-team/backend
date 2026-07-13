/**
 * walletIntelligenceService — the ChainQuant smart-money proxy index.
 *
 * This is the moat, and it is built from free data: GeckoTerminal returns the
 * buyer address of every trade on a pool. We record those trades, and later score
 * a wallet on what actually happened to the pools it bought into early.
 *
 * Critical honesty constraint: this index means NOTHING until it has accumulated
 * history. A wallet cannot be called "smart" on day one. Until `min_history_days`
 * of observation exist, every wallet score returns UNAVAILABLE with an explanation
 * rather than a confident-looking number.
 *
 * Wallet Behaviour Forecast (spec Priority 4) is intentionally NOT implemented as
 * a probability. Shipping "76% likely to keep accumulating" without a backtest
 * would be fabricating model accuracy. The shape is here; the numbers arrive only
 * after real historical evaluation exists.
 */
import { fetchPoolTrades } from './dexDataService.js';
import { db } from '../lib/db.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

const MIN_HISTORY_DAYS = 30;

/** Cron calls this. Records raw observations; draws no conclusions yet. */
export async function observePool(network, poolAddress, tokenSymbol) {
  const trades = await fetchPoolTrades(network, poolAddress);
  if (!trades.value?.length || !db) return 0;

  const rows = trades.value.map((t) => ({
    tx_hash: t.tx_hash,
    wallet_address: t.wallet.toLowerCase(),
    network,
    pool_address: poolAddress,
    token_symbol: tokenSymbol,
    side: t.kind,
    volume_usd: t.volume_usd,
    observed_at: t.at,
  }));

  const { error } = await db.from('wallet_observations').upsert(rows, { onConflict: 'tx_hash' });
  return error ? 0 : rows.length;
}

/** How much observation history do we actually have? Determines whether we may speak at all. */
export async function indexReadiness() {
  if (!db) return { ready: false, days: 0, observations: 0 };
  const { data } = await db.rpc('wallet_index_readiness');
  const days = data?.[0]?.days_of_history ?? 0;
  const obs = data?.[0]?.observation_count ?? 0;
  return { ready: days >= MIN_HISTORY_DAYS, days, observations: obs, min_history_days: MIN_HISTORY_DAYS };
}

export async function walletProfile(address) {
  const readiness = await indexReadiness();
  if (!readiness.ready) {
    return unavailable('ChainQuant proxy index',
      `The wallet index has ${readiness.days} day(s) of observed history and needs ${MIN_HISTORY_DAYS} before any wallet can be scored. No score is shown, because none would be meaningful.`);
  }
  if (!db) return unavailable('ChainQuant proxy index', 'Database not configured.');

  const { data } = await db
    .from('wallet_observations')
    .select('*')
    .eq('wallet_address', address.toLowerCase())
    .order('observed_at', { ascending: false })
    .limit(200);

  const trades = data || [];
  if (!trades.length) return unavailable('ChainQuant proxy index', 'This wallet has not been observed in any pool we track.');

  const buys = trades.filter((t) => t.side === 'buy');
  const sells = trades.filter((t) => t.side === 'sell');
  const buyUsd = buys.reduce((s, t) => s + Number(t.volume_usd || 0), 0);
  const sellUsd = sells.reduce((s, t) => s + Number(t.volume_usd || 0), 0);
  const net = buyUsd - sellUsd;

  return envelope({
    address,
    observed_trades: trades.length,
    buy_usd: buyUsd,
    sell_usd: sellUsd,
    net_flow_usd: net,
    recent_behaviour: net > 0 ? 'Net accumulating across observed pools' : net < 0 ? 'Net distributing across observed pools' : 'Balanced',
    forecast: {
      // Deliberately null. A probability here without a backtest would be an invented accuracy claim.
      predicted_behaviour: null,
      probability: null,
      note: 'Behaviour forecasting is not enabled. A probability will only be shown once ChainQuant has run a real historical evaluation of its own predictions. Until then, only observed behaviour is reported.',
    },
    recent_transactions: trades.slice(0, 10),
  }, {
    status: STATUS.MODEL,
    source: 'ChainQuant proxy index (GeckoTerminal trade feed)',
    model_version: 'chainquant_wallet_index_0.1.0',
    note: 'Observed behaviour only. Not a licensed smart-money label from any third party.',
  });
}
