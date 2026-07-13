/**
 * aiCommandService — Ask ChainQuant.
 *
 * The model is given ONLY the terminal's own data as context and is told, in the
 * system prompt, that it may not invent numbers and may not give financial advice.
 * Actions are returned as structured intents which the frontend executes — the
 * model never touches the database directly, and destructive intents (saving an
 * alert) require explicit user confirmation in the UI.
 *
 * If ANTHROPIC_API_KEY is absent, this service reports unavailable and the
 * frontend falls back to its deterministic keyword router. It does not pretend.
 */
import Anthropic from '@anthropic-ai/sdk';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';
import { parseAlert } from './alertService.js';

const KEY = process.env.ANTHROPIC_API_KEY || '';
const client = KEY ? new Anthropic({ apiKey: KEY }) : null;

const SYSTEM = `You are Ask ChainQuant, the analyst inside a crypto intelligence terminal.

Absolute rules:
- Use ONLY the data provided in the context block. If a number is not in the context, say it is unavailable. NEVER invent a figure, a wallet address, a transaction, or an accuracy claim.
- You are not a financial adviser. Never say buy, sell, or hold. Use: "worth reviewing", "signal detected", "risk increased", "conditions strengthened".
- Every score you cite is a model output, not a fact about the future. Say so when it matters.
- If the user asks for something the platform cannot currently measure (social momentum, holder concentration, LP concentration, wallet behaviour forecasts), say plainly that the data source is not connected and what would be needed.
- Be concise. Lead with the answer.

Return STRICT JSON only, no markdown fences:
{"answer": "...", "actions": [{"type":"open_report|apply_filter|compare|create_alert|add_watchlist|explain_score","payload":{...}}]}
Actions are suggestions the terminal will execute. create_alert must ALWAYS produce a draft the user reviews before saving.`;

export async function askChainQuant(question, context) {
  if (!client) {
    return unavailable('Anthropic', 'ANTHROPIC_API_KEY is not set. The terminal is using its deterministic command router instead.');
  }

  // Alert requests are parsed deterministically first — a rule the user can read and
  // edit beats a model's paraphrase of one.
  const alertish = /^(alert|notify|remind|tell me when)/i.test(question) || /alert me/i.test(question);

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `CONTEXT (the only data you may use):\n${JSON.stringify(context).slice(0, 60000)}\n\nQUESTION: ${question}`,
    }],
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    parsed = { answer: text, actions: [] };
  }

  if (alertish) {
    const draft = parseAlert(question);
    parsed.actions = [...(parsed.actions || []).filter((a) => a.type !== 'create_alert'),
      { type: 'create_alert', payload: draft.value }];
  }

  return envelope(parsed, {
    status: STATUS.MODEL,
    source: 'Anthropic + ChainQuant terminal data',
    model_version: 'ask_chainquant_1.0.0',
    note: 'Model-generated. Grounded only in the data shown in the terminal.',
  });
}
