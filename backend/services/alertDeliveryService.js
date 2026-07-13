/** Deliver persisted alert triggers. Provider failures never erase the trigger. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function message(rule, payload) {
  const symbol = String(payload.asset || 'Asset').toUpperCase();
  return {
    subject: `ChainQuant signal detected: ${symbol}`,
    text: `${rule.name || 'ChainQuant alert'}\n${symbol} — Opportunity ${payload.opportunity}, Risk ${payload.risk}\nObserved at ${payload.at}\n\nThis is an observed signal, not financial advice.`,
  };
}

async function sendEmail(rule, payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = rule.delivery?.email;
  if (!apiKey || !to) return { provider: 'resend', status: 'skipped', reason: !apiKey ? 'RESEND_API_KEY is not configured' : 'No email recipient on alert' };
  const m = message(rule, payload);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL || 'ChainQuant <alerts@chainquant.net>', to: [to], subject: m.subject,
      html: `<h2>${esc(m.subject)}</h2><p>${esc(rule.name || 'ChainQuant alert')}</p><p><strong>${esc(payload.asset)}</strong> — Opportunity ${esc(payload.opportunity)}, Risk ${esc(payload.risk)}</p><p>Observed at ${esc(payload.at)}</p><p><small>This is an observed signal, not financial advice.</small></p>`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  const body = await response.json();
  return { provider: 'resend', status: 'sent', id: body.id };
}

async function sendDiscord(rule, payload) {
  const webhook = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!webhook) return { provider: 'discord', status: 'skipped', reason: 'DISCORD_ALERT_WEBHOOK_URL is not configured' };
  const m = message(rule, payload);
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ChainQuant Alerts', content: `**${m.subject}**\n${m.text}` }) });
  if (!response.ok) throw new Error(`Discord returned ${response.status}`);
  return { provider: 'discord', status: 'sent' };
}

export async function deliverAlert(rule, payload) {
  return Promise.all([['resend', sendEmail], ['discord', sendDiscord]].map(async ([provider, send]) => {
    try { return await send(rule, payload); }
    catch (error) { return { provider, status: 'failed', reason: error.message }; }
  }));
}
