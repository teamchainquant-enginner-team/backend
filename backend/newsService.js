import { envelope, unavailable, STATUS } from '../lib/envelope.js';

const TOKEN = process.env.MARKETAUX_API_TOKEN || '';
const MODEL_VERSION = 'chainquant_headline_sentiment_v1.0.0';
const POSITIVE = new Set(['adoption','approval','approved','breakthrough','bullish','gain','gains','growth','launch','partnership','rally','record','surge','upgrade']);
const NEGATIVE = new Set(['attack','bearish','breach','crash','decline','drop','exploit','fraud','hack','lawsuit','loss','outage','risk','scam','selloff']);

export function headlineSentiment(headline) {
  const words = String(headline || '').toLowerCase().match(/[a-z]+/g) || [];
  const pos = words.filter((w) => POSITIVE.has(w)).length;
  const neg = words.filter((w) => NEGATIVE.has(w)).length;
  return { label: pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral', score: pos - neg, positive_terms: pos, negative_terms: neg };
}

export async function fetchCryptoNews() {
  if (!TOKEN) return unavailable('Marketaux', 'MARKETAUX_API_TOKEN is not configured. No headlines are generated to fill the gap.');
  const url = new URL('https://api.marketaux.com/v1/news/all');
  url.searchParams.set('api_token', TOKEN); url.searchParams.set('filter_entities', 'true');
  url.searchParams.set('must_have_entities', 'true'); url.searchParams.set('language', 'en');
  url.searchParams.set('limit', '3'); url.searchParams.set('search', 'crypto | bitcoin | ethereum | blockchain');
  const response = await fetch(url);
  if (!response.ok) return unavailable('Marketaux', `News provider returned HTTP ${response.status}.`);
  const body = await response.json();
  const articles = (body.data || []).map((a) => ({ id: a.uuid, headline: a.title, publisher: a.source, source_url: a.url, published_at: a.published_at, retrieved_at: new Date().toISOString(), entities: (a.entities || []).map((e) => e.symbol).filter(Boolean), sentiment: headlineSentiment(a.title) }));
  return envelope(articles, { status: STATUS.DELAYED, source: 'Marketaux', model_version: MODEL_VERSION, note: 'Verified headlines. Sentiment is a deterministic headline model, not a forecast.' });
}
