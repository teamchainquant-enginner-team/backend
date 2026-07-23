/* ═══════════════════════════════════════════════════════════════════════════
   server.js ADDITIONS — paste these into backend/server.js.
   (This file is a patch reference, not a standalone module.)

   1) Add these imports beside the other service imports near the top:
   ─────────────────────────────────────────────────────────────────────────── */
import { ohlc } from './services/ohlcService.js';
import { resolveEntity } from './services/entityService.js';
import { listTracked, addTracked, removeTracked, portfolioForUser } from './services/walletTrackerService.js';

/* 2) Add these route blocks with the other app.get/app.post handlers.
   They reuse the existing `wrap`, `requireUser`, `db`, `envelope`, `STATUS`,
   `unavailable`, and `getCache` already defined in server.js.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── OHLC proxy — feeds the multi-timeframe report chart ─────────────────── */
app.get('/api/ohlc/:id', wrap(async (req, res) => {
  res.json(await ohlc(req.params.id, String(req.query.tf || '1h')));
}));

/* ── Entity Layer (ChainQuant ID) ────────────────────────────────────────── */
app.get('/api/entity/:query', wrap(async (req, res) => {
  res.json(await resolveEntity(req.params.query));
}));

/* ── Portfolio Wallet Tracker (track, never connect) ─────────────────────── */
app.get('/api/tracked-wallets', requireUser, wrap(async (req, res) => {
  res.json(envelope(await listTracked(req.user.id), { status: STATUS.LIVE, source: 'ChainQuant wallet tracker' }));
}));

app.post('/api/tracked-wallets', requireUser, wrap(async (req, res) => {
  const { address, chain = 'eth', label, kind, portfolio_group } = req.body || {};
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(address || '');
  const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || '');
  if (!address || (!isEvm && !isSol)) {
    return res.status(400).json(unavailable('ChainQuant wallet tracker', 'A valid public address is required. No signature or key is ever requested.'));
  }
  res.json(envelope(await addTracked(req.user.id, { address, chain, label, kind, portfolio_group }),
    { status: STATUS.LIVE, source: 'ChainQuant wallet tracker' }));
}));

app.delete('/api/tracked-wallets/:id', requireUser, wrap(async (req, res) => {
  res.json(envelope(await removeTracked(req.user.id, req.params.id), { status: STATUS.LIVE, source: 'ChainQuant wallet tracker' }));
}));

/* Aggregated portfolio across the user's tracked wallets. */
app.get('/api/portfolio/tracked', requireUser, wrap(async (req, res) => {
  res.json(await portfolioForUser(req.user.id));
}));

/* ── Personalized overview widgets ───────────────────────────────────────── */
app.get('/api/dashboard/:surface', requireUser, wrap(async (req, res) => {
  const { data } = await db.from('dashboard_layouts').select('widgets')
    .eq('user_id', req.user.id).eq('surface', req.params.surface).maybeSingle();
  res.json(envelope(data?.widgets || [], { status: STATUS.LIVE, source: 'ChainQuant layouts' }));
}));

app.put('/api/dashboard/:surface', requireUser, wrap(async (req, res) => {
  const widgets = Array.isArray(req.body?.widgets) ? req.body.widgets : [];
  const { data, error } = await db.from('dashboard_layouts')
    .upsert({ user_id: req.user.id, surface: req.params.surface, widgets, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,surface' })
    .select().single();
  if (error) throw error;
  res.json(envelope(data.widgets, { status: STATUS.LIVE, source: 'ChainQuant layouts' }));
}));

/* ── Saved filters (table already exists in schema.sql) ──────────────────── */
app.get('/api/filters', requireUser, wrap(async (req, res) => {
  const { data } = await db.from('saved_filters').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json(envelope(data || [], { status: STATUS.LIVE, source: 'ChainQuant filters' }));
}));

app.post('/api/filters', requireUser, wrap(async (req, res) => {
  const { name, filters } = req.body || {};
  if (!name || typeof filters !== 'object') return res.status(400).json(unavailable('ChainQuant filters', 'name and filters are required.'));
  const { data, error } = await db.from('saved_filters').insert({ user_id: req.user.id, name, filters }).select().single();
  if (error) throw error;
  res.json(envelope(data, { status: STATUS.LIVE, source: 'ChainQuant filters' }));
}));

app.delete('/api/filters/:id', requireUser, wrap(async (req, res) => {
  await db.from('saved_filters').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json(envelope({ deleted: true }, { status: STATUS.LIVE, source: 'ChainQuant filters' }));
}));
