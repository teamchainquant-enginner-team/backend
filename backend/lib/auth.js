/**
 * Authentication.
 *
 * The rule this file exists to enforce: THE SERVER NEVER TRUSTS A user_id SENT
 * BY THE CLIENT. Before this existed, `POST /api/alerts` took `user_id` from the
 * request body — meaning anyone could read or write anyone else's alerts, and the
 * RLS policies in schema.sql (written against auth.uid()) were doing nothing,
 * because the backend was connecting with the service key which bypasses them.
 *
 * The user id is now derived from a verified Supabase JWT and nowhere else.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const verifier = url && anon ? createClient(url, anon, { auth: { persistSession: false } }) : null;

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Attaches req.user when a valid token is present. Never throws. */
export async function attachUser(req, _res, next) {
  req.user = null;
  const token = bearer(req);
  if (!token || !verifier) return next();
  try {
    const { data, error } = await verifier.auth.getUser(token);
    if (!error && data?.user) req.user = { id: data.user.id, email: data.user.email };
  } catch { /* invalid token → stays anonymous */ }
  next();
}

/** Gate for anything that reads or writes user-owned data. */
export function requireUser(req, res, next) {
  if (!verifier) {
    return res.status(503).json({
      value: null, status: 'unavailable', source: 'ChainQuant auth',
      note: 'SUPABASE_ANON_KEY is not set, so tokens cannot be verified. User-owned endpoints are disabled rather than left open.',
    });
  }
  if (!req.user) {
    return res.status(401).json({
      value: null, status: 'unavailable', source: 'ChainQuant auth',
      note: 'Sign in required. This endpoint reads or writes data owned by a specific user.',
    });
  }
  next();
}
