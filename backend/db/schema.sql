-- ChainQuant — Supabase schema (project: segccrrecdhzfwgptqsi)
--
-- ⚠️ THIS FILE IS A RECORD, NOT A TO-DO.
-- These migrations were APPLIED to the live project on 2026-07-13 and verified.
-- Do not re-run blindly; they are kept here so the schema is reviewable in the repo.
--
-- Applied migrations, in order:
--   1. chainquant_intelligence_extend_alerts
--   2. chainquant_intelligence_core_tables
--   3. chainquant_wallet_index_functions
--   4. chainquant_watchlist_upsert_index
--   5. chainquant_alert_type_allow_intelligence_types
--   6. chainquant_sync_auth_users_to_public_users
--
-- THREE THINGS THE LIVE DB TAUGHT US (the original draft of this file was wrong):
--
--   a) `alerts` ALREADY EXISTED with a different shape: NOT NULL name / alert_type /
--      delivery, and is_active (boolean) instead of status (text). A `create table if
--      not exists` would have silently no-opped and left the backend inserting into a
--      table with the wrong columns. We extended it instead.
--
--   b) `alerts.alert_type` had a CHECK constraint allowing only
--      price | whale_move | wallet_activity | narrative | volume.
--      Natural-language rules need more. The constraint was widened, keeping every
--      original value so nothing already stored became invalid.
--
--   c) PRE-EXISTING BUG: alerts.user_id and saved_watchlists.user_id both FK to
--      public.users(id) — and public.users was EMPTY (0 rows against 2 auth users).
--      No user could ever have saved an alert or a watchlist; every insert died on the
--      foreign key. Fixed with a backfill plus an on_auth_user_created trigger.
--
-- Watchlists use the EXISTING public.saved_watchlists table. There is no separate
-- `watchlists` table and there must not be one.

-- ── 1. Extend the existing alerts table ───────────────────────────────────
alter table public.alerts add column if not exists natural_language text;
alter table public.alerts add column if not exists scope       text not null default 'market';
alter table public.alerts add column if not exists asset       text;
alter table public.alerts add column if not exists logic       text not null default 'all';
alter table public.alerts add column if not exists time_window text not null default '24h';

alter table public.alerts alter column name       set default 'ChainQuant alert';
alter table public.alerts alter column alert_type set default 'chainquant_nl';
alter table public.alerts alter column delivery   set default '{"in_app": true}'::jsonb;
alter table public.alerts alter column is_active  set default true;

alter table public.alerts drop constraint if exists alerts_alert_type_check;
alter table public.alerts add constraint alerts_alert_type_check
  check (alert_type = any (array['price','whale_move','wallet_activity','narrative','volume',
                                 'opportunity_score','risk_score','liquidity','exchange_transfer',
                                 'chainquant_nl']));

-- ── 2. Core intelligence tables ───────────────────────────────────────────
create table if not exists public.cache_snapshots (
  key text primary key, payload jsonb not null, source text,
  fetched_at timestamptz not null default now());
alter table public.cache_snapshots enable row level security;
drop policy if exists cache_read on public.cache_snapshots;
create policy cache_read on public.cache_snapshots for select to anon, authenticated using (true);
grant select on public.cache_snapshots to anon, authenticated;

create table if not exists public.score_history (
  id bigserial primary key, asset_id text not null,
  opportunity_score int not null, risk_score int not null,
  opportunity_drivers jsonb, risk_drivers jsonb,
  model_version text not null, calculated_at timestamptz not null default now());
create index if not exists score_history_asset_time on public.score_history (asset_id, calculated_at desc);
alter table public.score_history enable row level security;
drop policy if exists score_history_read on public.score_history;
create policy score_history_read on public.score_history for select to anon, authenticated using (true);
grant select on public.score_history to anon, authenticated;

-- No anon select: the wallet index is the moat, served only through the API.
create table if not exists public.wallet_observations (
  tx_hash text primary key, wallet_address text not null, network text not null,
  pool_address text not null, token_symbol text,
  side text check (side in ('buy','sell')), volume_usd numeric,
  observed_at timestamptz not null);
create index if not exists wallet_obs_addr on public.wallet_observations (wallet_address, observed_at desc);
create index if not exists wallet_obs_size on public.wallet_observations (volume_usd desc, observed_at desc);
alter table public.wallet_observations enable row level security;

create table if not exists public.alert_triggers (
  id bigserial primary key,
  alert_id uuid not null references public.alerts(id) on delete cascade,
  payload jsonb not null, delivered boolean not null default false,
  triggered_at timestamptz not null default now());
alter table public.alert_triggers add column if not exists delivery_results jsonb not null default '[]'::jsonb;
alter table public.alert_triggers add column if not exists delivered_at timestamptz;
create index if not exists alert_triggers_alert on public.alert_triggers (alert_id, triggered_at desc);
alter table public.alert_triggers enable row level security;
drop policy if exists alert_triggers_own on public.alert_triggers;
create policy alert_triggers_own on public.alert_triggers for select to authenticated
  using (exists (select 1 from public.alerts a where a.id = alert_id and a.user_id = auth.uid()));
grant select on public.alert_triggers to authenticated;

-- Labeled addresses. Maintained BY US — never licensed from a prohibited provider.
create table if not exists public.labeled_addresses (
  address text primary key, label text not null,
  category text not null check (category in ('exchange','bridge','market_maker','treasury','deployer','other')),
  network text, added_at timestamptz not null default now());
alter table public.labeled_addresses enable row level security;

create table if not exists public.portfolio_snapshots (
  id bigserial primary key, user_id uuid not null, payload jsonb not null,
  created_at timestamptz not null default now());
alter table public.portfolio_snapshots enable row level security;
drop policy if exists portfolio_own on public.portfolio_snapshots;
create policy portfolio_own on public.portfolio_snapshots for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert on public.portfolio_snapshots to authenticated;

create table if not exists public.ai_commands (
  id bigserial primary key, user_id uuid, question text not null, answer jsonb,
  created_at timestamptz not null default now());
alter table public.ai_commands enable row level security;
drop policy if exists ai_own on public.ai_commands;
create policy ai_own on public.ai_commands for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert on public.ai_commands to authenticated;

create table if not exists public.saved_filters (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  name text not null, filters jsonb not null, created_at timestamptz not null default now());
alter table public.saved_filters enable row level security;
drop policy if exists filters_own on public.saved_filters;
create policy filters_own on public.saved_filters for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.saved_filters to authenticated;

create table if not exists public.feedback (
  id bigserial primary key, user_id uuid, surface text not null,
  rating text check (rating in ('up','down')), note text,
  created_at timestamptz not null default now());
alter table public.feedback enable row level security;
drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback for insert to authenticated with check (true);
grant insert on public.feedback to authenticated;

-- ── 3. Wallet index functions ─────────────────────────────────────────────
-- Gates whether ANY wallet may be scored. A wallet cannot be called "smart" on day one.
create or replace function public.wallet_index_readiness()
returns table (days_of_history int, observation_count bigint)
language sql security definer set search_path = public as $$
  select coalesce(extract(day from (now() - min(observed_at)))::int, 0), count(*)
  from public.wallet_observations;
$$;
grant execute on function public.wallet_index_readiness() to anon, authenticated;

create or replace function public.top_observed_wallets(limit_n int default 20)
returns table (wallet_address text, observed_trades bigint, buy_usd numeric,
               sell_usd numeric, net_flow_usd numeric, first_seen timestamptz, last_seen timestamptz)
language sql security definer set search_path = public as $$
  select wallet_address, count(*),
    coalesce(sum(volume_usd) filter (where side='buy'),0),
    coalesce(sum(volume_usd) filter (where side='sell'),0),
    coalesce(sum(volume_usd) filter (where side='buy'),0) - coalesce(sum(volume_usd) filter (where side='sell'),0),
    min(observed_at), max(observed_at)
  from public.wallet_observations
  group by wallet_address
  having count(*) >= 3   -- a single trade tells us nothing about a wallet
  order by 5 desc limit limit_n;
$$;
grant execute on function public.top_observed_wallets(int) to anon, authenticated;

-- ── 4. Watchlist upsert target ────────────────────────────────────────────
create unique index if not exists saved_watchlists_user_name on public.saved_watchlists (user_id, name);

-- ── 5. auth.users -> public.users sync (THE BUG FIX) ──────────────────────
insert into public.users (id, email, full_name, created_at)
select u.id, u.email,
       coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'), u.created_at
from auth.users u
on conflict (id) do nothing;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, created_at)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), now())
  on conflict (id) do update set email = excluded.email;

  insert into public.profiles (id, email, full_name, created_at)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), now())
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
