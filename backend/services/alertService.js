/**
 * alertService — natural-language alerts, parsed into structured rules.
 *
 * Hard rule: the parsed rule is RETURNED FOR REVIEW, never saved silently.
 * The user must see and be able to edit the conditions before anything is armed.
 * `parseAlert()` therefore returns a draft; `saveAlert()` is a separate call that
 * only the user's explicit confirmation may trigger.
 */
import { db } from '../lib/db.js';
import { envelope, STATUS } from '../lib/envelope.js';
import { deliverAlert } from './alertDeliveryService.js';

const FIELDS = {
  opportunity_score: /(flip|opportunity)\s*score/i,
  risk_score: /risk\s*score|liquidity risk/i,
  price: /\bprice\b/i,
  volume: /\bvolume\b/i,
  narrative_velocity: /narrative (velocity|momentum)/i,
  smart_wallet_buys: /(smart\s*wallets?|tracked wallets?)\s*(buy|bought|accumulat)/i,
  exchange_transfer: /transfer(ring)? .*(to (an )?exchange)|sends? to (an )?exchange/i,
  lifecycle_stage: /(declining|accelerating|emerging|peaking|crowded|dormant) narrative/i,
};

/**
 * Deterministic parse. No model call — a rule the user can read beats a clever guess.
 *
 * Parsing is CLAUSE-SCOPED. "Flip Score above 80 while liquidity risk remains low"
 * contains two conditions with different thresholds; a naive global regex would
 * apply "80" to both and arm a rule the user never asked for. Each clause is
 * therefore parsed in isolation.
 */
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function numIn(clause, re) {
  const m = clause.match(re);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return WORD_NUM[raw] ?? Number(raw);
}

function parseClause(clause, conditions, warnings) {
  const N = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)';
  const above = numIn(clause, new RegExp(`(?:above|over|greater than|rises? above|more than|>)\\s*${N}`, 'i'));
  const below = numIn(clause, new RegExp(`(?:below|under|less than|drops? below|<)\\s*${N}`, 'i'));
  const pct = numIn(clause, new RegExp(`${N}\\s*%`, 'i'));
  const count = numIn(clause, new RegExp(`${N}\\s*(?:or more\\s*)?(?:smart\\s*|tracked\\s*)?wallets?`, 'i'));
  const isLow = /\b(low|remains low|stays low)\b/i.test(clause);
  const isHigh = /\b(high|remains high|elevated)\b/i.test(clause);

  for (const [field, re] of Object.entries(FIELDS)) {
    if (!re.test(clause)) continue;

    if (field === 'opportunity_score' || field === 'risk_score' || field === 'price' || field === 'volume') {
      if (above != null) conditions.push({ field, operator: 'gt', value: above });
      else if (below != null) conditions.push({ field, operator: 'lt', value: below });
      // "liquidity risk remains low" has no number — it is still a real condition.
      else if (field === 'risk_score' && isLow) conditions.push({ field, operator: 'lt', value: 45 });
      else if (field === 'risk_score' && isHigh) conditions.push({ field, operator: 'gt', value: 70 });
      else warnings.push(`"${field}" was mentioned without a threshold. Set one before saving.`);
    } else if (field === 'narrative_velocity') {
      if (pct != null) conditions.push({ field, operator: 'increases_by_pct', value: pct });
      else warnings.push('Narrative velocity was mentioned without a percentage. Set one before saving.');
    } else if (field === 'smart_wallet_buys') {
      conditions.push({ field, operator: 'gte_count', value: count ?? 3 });
      if (count == null) warnings.push('No wallet count was given; 3 was assumed. Edit it if that is wrong.');
    } else if (field === 'exchange_transfer') {
      conditions.push({ field, operator: 'occurs', value: true });
    } else if (field === 'lifecycle_stage') {
      const stage = (clause.match(/\b(declining|accelerating|emerging|peaking|crowded|dormant)\b/i) || [])[1];
      conditions.push({ field, operator: 'enters', value: stage ? stage[0].toUpperCase() + stage.slice(1).toLowerCase() : 'Declining' });
    }
  }
}

export function parseAlert(text) {
  const s = String(text || '');
  const conditions = [];
  const warnings = [];

  const asset = (s.match(/\b(BTC|ETH|SOL|WIF|PEPE|BONK|ARB|OP|LINK|UNI|AVAX|INJ|TIA|DOGE|BNB|FET|ONDO|RNDR)\b/i) || [])[1] || null;

  // Split on connectives so each condition keeps its own threshold.
  const clauses = s.split(/\bwhile\b|\band\b|\bwith\b|,|;/i).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) parseClause(clause, conditions, warnings);

  // De-duplicate on field, keeping the first (left-most) reading.
  const seen = new Set();
  const deduped = conditions.filter((c) => (seen.has(c.field) ? false : (seen.add(c.field), true)));

  const unsupported = [];
  if (/social/i.test(s)) unsupported.push('Social momentum conditions cannot be armed: no social data source is connected.');
  if (/whale/i.test(s) && !deduped.length) unsupported.push('Whale-activity conditions require the wallet index, which is still accumulating history.');

  return envelope({
    draft: true, // never armed until the user confirms
    natural_language: s,
    asset,
    scope: asset ? 'asset' : /portfolio/i.test(s) ? 'portfolio' : /watchlist/i.test(s) ? 'watchlist' : 'market',
    conditions: deduped,
    logic: 'all',
    time_window: (s.match(/\b(24h|7d|1h|30m)\b/i) || [])[1] || '24h',
    warnings,
    unsupported,
    parseable: deduped.length > 0,
  }, {
    status: STATUS.MODEL,
    source: 'ChainQuant alert parser',
    model_version: 'chainquant_alert_parser_1.1.0',
    note: 'This is a DRAFT rule. It is not active. Review and edit the conditions, then save to arm it.',
  });
}

/**
 * NOTE ON SCHEMA: the `alerts` table pre-dates this service. It has NOT NULL
 * `name`, `alert_type` and `delivery` columns and uses `is_active` (boolean),
 * not a `status` string. We conform to the live table rather than duplicating it.
 */
export async function saveAlert(userId, rule, userEmail = null) {
  if (!db) throw new Error('Database not configured.');
  if (!rule?.conditions?.length) throw new Error('An alert needs at least one condition.');

  const nl = (rule.natural_language || '').trim();
  const { data, error } = await db.from('alerts').insert({
    user_id: userId,
    name: nl.slice(0, 60) || 'ChainQuant alert',   // NOT NULL on the existing table
    alert_type: 'chainquant_nl',                    // NOT NULL
    delivery: { in_app: true, email: userEmail },   // verified JWT email; never trusted from request body
    conditions: rule.conditions,
    natural_language: nl,
    scope: rule.scope,
    asset: rule.asset,
    logic: rule.logic,
    time_window: rule.time_window,
    is_active: true,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function listAlerts(userId) {
  if (!db) return [];
  const { data } = await db
    .from('alerts')
    .select('*, alert_triggers(triggered_at, payload)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  // Normalize the legacy boolean into the status string the UI speaks.
  return (data || []).map((r) => ({ ...r, status: r.is_active ? 'active' : 'paused' }));
}

/** Evaluate active rules against the latest scored snapshot. Called by the cron worker. */
export async function evaluateAlerts(scored) {
  if (!db) return 0;
  const { data: rules } = await db.from('alerts').select('*').eq('is_active', true);
  let fired = 0;

  for (const rule of rules || []) {
    const candidates = rule.asset
      ? scored.filter((a) => (a.symbol || '').toUpperCase() === rule.asset.toUpperCase())
      : scored;

    for (const a of candidates) {
      const ok = rule.conditions.every((c) => {
        const v = c.field === 'opportunity_score' ? a.opportunity.score
          : c.field === 'risk_score' ? a.risk.score
          : c.field === 'price' ? a.current_price
          : c.field === 'volume' ? a.total_volume
          : null;
        if (v == null) return false; // an unmeasurable condition never fires a false positive
        if (c.operator === 'gt') return v > c.value;
        if (c.operator === 'lt') return v < c.value;
        return false;
      });
      if (!ok) continue;

      const payload = { asset: a.symbol, opportunity: a.opportunity.score, risk: a.risk.score, at: new Date().toISOString() };
      const { data: trigger, error: triggerError } = await db.from('alert_triggers').insert({
        alert_id: rule.id,
        payload,
      }).select('id').single();
      if (triggerError) throw triggerError;
      const deliveryResults = await deliverAlert(rule, payload);
      await db.from('alert_triggers').update({
        delivery_results: deliveryResults,
        delivered: deliveryResults.some((r) => r.status === 'sent'),
        delivered_at: deliveryResults.some((r) => r.status === 'sent') ? new Date().toISOString() : null,
      }).eq('id', trigger.id);
      // The existing table tracks these two columns; keep them accurate.
      await db.from('alerts')
        .update({ last_triggered: new Date().toISOString(), trigger_count: (rule.trigger_count || 0) + 1 })
        .eq('id', rule.id);
      fired++;
      break; // one trigger per rule per cycle
    }
  }
  return fired;
}

/** Ownership is checked in the query, not assumed. A user may only touch their own rules. */
export async function setAlertStatus(userId, alertId, status) {
  if (!db) throw new Error('Database not configured.');
  const { data, error } = await db.from('alerts')
    .update({ is_active: status === 'active' })
    .eq('id', alertId)
    .eq('user_id', userId)   // <- the authorization check
    .select().single();
  if (error) throw error;
  if (!data) throw new Error('Alert not found for this user.');
  return data;
}

export async function deleteAlert(userId, alertId) {
  if (!db) throw new Error('Database not configured.');
  const { error } = await db.from('alerts').delete().eq('id', alertId).eq('user_id', userId);
  if (error) throw error;
}
