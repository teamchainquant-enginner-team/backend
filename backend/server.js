/**
 * ChainQuant API — Railway.
 *
 * Architecture note (this is the whole point):
 * The browser NEVER calls CoinGecko, GeckoTerminal, DexScreener, DefiLlama or
 * Etherscan directly. The cron worker polls them on a schedule and writes to
 * Supabase; every user reads the same cached snapshot from this API.
 *
 * Consequence: data cost is O(1) in users, not O(n). One backend making ~40
 * calls/minute serves 10 users or 10,000 identically, which is what lets the
 * platform run entirely on free API tiers until paid plans are justified.
 * It also means no API key ever reaches a browser.
 */
import express from 'express';
import cors from 'cors';
import { getCache, dbReady, db } from './lib/db.js';
import { envelope, delayed, unavailable, STATUS } from './lib/envelope.js';
import { liquidityIntel } from './services/liquidityService.js';
import { deployerIntel } from './services/deployerService.js';
import { narratives, rotation } from './services/narrativeService.js';
import { socialMomentum } from './services/socialIntelligenceService.js';
import { walletProfile, indexReadiness } from './services/walletIntelligenceService.js';
import { parseAlert, saveAlert, listAlerts, setAlertStatus, deleteAlert } from './services/alertService.js';
import { portfolioIntel } from './services/portfolioIntelligenceService.js';
import { askChainQuant } from './services/aiCommandService.js';
import { attachUser, requireUser } from './lib/auth.js';
import { balances, priceHoldings } from './services/balanceService.js';
import { comboRead } from './services/scoringService.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

// Every request gets its identity resolved from a verified JWT (or stays anonymous).
// No route may read a user id from the request body.
app.use(attachUser);

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json(unavailable('ChainQuant API', 'This service is temporarily unavailable.'));
});

/* ── Health ──────────────────────────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({
  ok: true,
  database: dbReady(),
  providers: {
    coingecko: process.env.COINGECKO_API_KEY ? 'paid' : 'free (keyless)',
    geckoterminal: 'free (keyless)',
    dexscreener: 'free (keyless)',
    defillama: 'free (keyless)',
    etherscan: process.env.ETHERSCAN_API_KEY ? 'free key set' : 'NOT SET — deployer intelligence disabled',
    social: process.env.TWITTERAPI_IO_KEY ? 'connected' : 'NOT PURCHASED — social surfaces render Unavailable',
    ask_chainquant: process.env.ANTHROPIC_API_KEY ? 'connected' : 'NOT SET — frontend uses deterministic router',
    auth: process.env.SUPABASE_ANON_KEY ? 'enabled (JWT verified)' : 'NOT SET — user-owned endpoints return 503 rather than being left open',
  },
}));

/* ── Market + scores (served from the cron-written cache) ────────────────── */
app.get('/api/markets', wrap(async (_req, res) => {
  const row = await getCache('markets:scored');
  if (!row) return res.json(unavailable('ChainQuant cache', 'The market snapshot has not been written yet. The cron worker runs every 3 minutes.'));
  res.json(delayed(row.payload, row.source, row.fetched_at, 'Served from the ChainQuant snapshot cache, refreshed every 3 minutes.'));
}));

app.get('/api/score/:id', wrap(async (req, res) => {
  const row = await getCache('markets:scored');
  const a = (row?.payload || []).find((x) => x.id === req.params.id);
  if (!a) return res.json(unavailable('ChainQuant cache', 'Asset not found in the current snapshot.'));
  res.json(envelope({
    opportunity: a.opportunity,
    risk: a.risk,
    combined_read: comboRead(a.opportunity.score, a.risk.score),
  }, { status: STATUS.MODEL, source: 'ChainQuant scoring engine', model_version: a.opportunity.model_version }));
}));

/** Score history — the reason scoring moved server-side at all. */
app.get('/api/score/:id/history', wrap(async (req, res) => {
  if (!db) return res.json(unavailable('Supabase', 'Database not configured.'));
  const { data } = await db.from('score_history')
    .select('opportunity_score,risk_score,model_version,calculated_at')
    .eq('asset_id', req.params.id)
    .order('calculated_at', { ascending: false })
    .limit(168);
  res.json(envelope(data || [], { status: STATUS.LIVE, source: 'ChainQuant score history' }));
}));

/* ── Liquidity + deployer ────────────────────────────────────────────────── */
app.get('/api/liquidity/:network/:address', wrap(async (req, res) => {
  const mc = Number(req.query.market_cap || 0);
  res.json(await liquidityIntel(req.params.network, req.params.address, { marketCap: mc }));
}));

app.get('/api/deployer/:chain/:address', wrap(async (req, res) => {
  res.json(await deployerIntel(req.params.chain, req.params.address));
}));

/* ── Narratives ──────────────────────────────────────────────────────────── */
app.get('/api/narratives', wrap(async (_req, res) => {
  const row = await getCache('narratives');
  if (row) return res.json(delayed(row.payload, row.source, row.fetched_at));
  res.json(await narratives());
}));

app.get('/api/narratives/rotation', wrap(async (_req, res) => res.json(await rotation())));

/* ── Social: honest unavailability ───────────────────────────────────────── */
app.get('/api/social/:symbol', wrap(async (req, res) => res.json(await socialMomentum(req.params.symbol))));

/* ── Wallets ─────────────────────────────────────────────────────────────── */
/**
 * Top wallets BY OBSERVED BEHAVIOUR — and only once the index has enough history.
 * Before that this returns unavailable. It does not return a plausible-looking
 * leaderboard, which is exactly what the old frontend generated with Math.random().
 */
app.get('/api/wallets/top', wrap(async (_req, res) => {
  const readiness = await indexReadiness();
  if (!readiness.ready) {
    return res.json(unavailable('ChainQuant proxy index',
      `The wallet index has ${readiness.days} day(s) of observed history and needs ${readiness.min_history_days || 30} before any wallet can be ranked. No leaderboard is shown, because none would mean anything yet.`));
  }
  const { data } = await db.rpc('top_observed_wallets', { limit_n: 20 });
  res.json(envelope(data || [], {
    status: STATUS.MODEL,
    source: 'ChainQuant proxy index (GeckoTerminal trade feed)',
    model_version: 'chainquant_wallet_index_0.1.0',
    note: 'Ranked on observed net flow across pools ChainQuant tracks. Not a licensed label from any third party.',
  }));
}));

/**
 * Whale feed — REAL, and available from day one.
 *
 * These are actual observed trades from the GeckoTerminal pool feed above a size
 * threshold: real tx hashes, real buyer addresses, real dollar amounts. Unlike
 * wallet *scoring* (which needs 30 days of history before it means anything),
 * a large trade is a fact the moment we see it.
 *
 * This replaces generateWhaleTx() — three Math.random() calls that invented
 * transaction hashes and wallet labels and presented them as a live feed.
 */
app.get('/api/whales', wrap(async (req, res) => {
  if (!db) return res.json(unavailable('Supabase', 'Database not configured.'));
  const min = Number(req.query.min_usd || 100000);
  const { data } = await db
    .from('wallet_observations')
    .select('tx_hash,wallet_address,network,token_symbol,side,volume_usd,observed_at')
    .gte('volume_usd', min)
    .order('observed_at', { ascending: false })
    .limit(40);
  if (!data?.length) {
    return res.json(unavailable('ChainQuant pool feed',
      `No trades above $${min.toLocaleString()} have been observed yet in the pools ChainQuant tracks. The feed fills as the cron worker observes them — nothing is generated to fill the gap.`));
  }
  res.json(envelope(data, {
    status: STATUS.DELAYED,
    source: 'GeckoTerminal pool trade feed',
    note: 'Observed trades above the size threshold. Real transaction hashes and buyer addresses. Wallet identity is not labelled — we report the address, not a guess about who owns it.',
  }));
}));

app.get('/api/wallet/index-status', wrap(async (_req, res) => res.json(envelope(await indexReadiness(), { status: STATUS.LIVE, source: 'ChainQuant proxy index' }))));
app.get('/api/wallet/:address', wrap(async (req, res) => res.json(await walletProfile(req.params.address))));

/* ── Alerts: parse → review → save. Never save silently. ─────────────────── */
app.post('/api/alerts/parse', wrap(async (req, res) => {
  res.json(parseAlert(req.body?.text || ''));
}));

app.post('/api/alerts', requireUser, wrap(async (req, res) => {
  const { rule, confirmed } = req.body || {};
  if (!confirmed) {
    return res.status(400).json(unavailable('ChainQuant alerts', 'An alert can only be saved after the user has reviewed the generated rule. Send confirmed: true.'));
  }
  // req.user.id comes from the verified token — NOT from the body.
  res.json(envelope(await saveAlert(req.user.id, rule, req.user.email), { status: STATUS.LIVE, source: 'ChainQuant alerts' }));
}));

app.get('/api/alerts', requireUser, wrap(async (req, res) => {
  res.json(envelope(await listAlerts(req.user.id), { status: STATUS.LIVE, source: 'ChainQuant alerts' }));
}));

app.patch('/api/alerts/:id', requireUser, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'paused'].includes(status)) return res.status(400).json(unavailable('ChainQuant alerts', 'status must be active or paused.'));
  res.json(envelope(await setAlertStatus(req.user.id, req.params.id, status), { status: STATUS.LIVE, source: 'ChainQuant alerts' }));
}));

app.delete('/api/alerts/:id', requireUser, wrap(async (req, res) => {
  await deleteAlert(req.user.id, req.params.id);
  res.json(envelope({ deleted: true }, { status: STATUS.LIVE, source: 'ChainQuant alerts' }));
}));

/* ── Portfolio ───────────────────────────────────────────────────────────── */

/**
 * Balances for a PUBLIC address. No auth required — a public address is public,
 * and requiring sign-in to look one up would be theatre. Nothing here is written.
 */
app.get('/api/portfolio/balances/:chain/:address', wrap(async (req, res) => {
  const bal = await balances(req.params.chain, req.params.address);
  if (!bal.value) return res.json(bal);
  const row = await getCache('markets:scored');
  const priced = priceHoldings(bal.value.holdings, row?.payload || []);
  const total = priced.reduce((s, h) => s + (h.value_usd || 0), 0);
  const unpriced = priced.filter((h) => !h.priced).length;
  res.json(envelope({
    ...bal.value,
    holdings: priced,
    total_value_usd: total,
    unpriced_positions: unpriced,
    note_unpriced: unpriced ? `${unpriced} holding(s) have no price in the current market snapshot and are shown without a value rather than being estimated.` : null,
  }, { status: bal.status, source: bal.source + ' + CoinGecko', note: bal.note }));
}));

/** Personalised intelligence is user-owned: it is stored, so it needs an account. */
app.post('/api/portfolio/intel', requireUser, wrap(async (req, res) => {
  const row = await getCache('markets:scored');
  const nar = await getCache('narratives');
  const intel = await portfolioIntel(req.body?.holdings || [], row?.payload || [], nar?.payload || []);
  if (db) await db.from('portfolio_snapshots').insert({ user_id: req.user.id, payload: intel.value });
  res.json(intel);
}));

/* ── Watchlists (user-owned) ─────────────────────────────────────────────── */
// Uses the EXISTING saved_watchlists table — no duplicate watchlist store.
app.get('/api/watchlists', requireUser, wrap(async (req, res) => {
  const { data } = await db.from('saved_watchlists').select('*').eq('user_id', req.user.id);
  res.json(envelope(data || [], { status: STATUS.LIVE, source: 'ChainQuant watchlists' }));
}));

app.post('/api/watchlists', requireUser, wrap(async (req, res) => {
  const { name = 'Default', assets = [], description = null } = req.body || {};
  const { data, error } = await db.from('saved_watchlists')
    .upsert({ user_id: req.user.id, name, assets, description }, { onConflict: 'user_id,name' })
    .select().single();
  if (error) throw error;
  res.json(envelope(data, { status: STATUS.LIVE, source: 'ChainQuant watchlists' }));
}));

/* ── Ask ChainQuant ──────────────────────────────────────────────────────── */
app.post('/api/ask', wrap(async (req, res) => {
  const { question, context } = req.body || {};
  if (!question) return res.status(400).json(unavailable('Ask ChainQuant', 'No question provided.'));
  const row = await getCache('markets:scored');
  const nar = await getCache('narratives');
  const grounded = {
    ...(context || {}),
    assets: (row?.payload || []).slice(0, 40),
    narratives: (nar?.payload || []).slice(0, 15),
    snapshot_at: row?.fetched_at,
    unavailable_surfaces: ['social momentum', 'holder concentration', 'LP concentration', 'wallet behaviour forecast'],
  };
  const answer = await askChainQuant(question, grounded);
  if (db && req.user) await db.from('ai_commands').insert({ user_id: req.user.id, question, answer: answer.value });
  res.json(answer);
}));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ChainQuant API on :${port} | db=${dbReady()}`));
