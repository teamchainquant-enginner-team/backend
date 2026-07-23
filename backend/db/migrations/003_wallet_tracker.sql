-- 003 · Portfolio Wallet Tracker (track, never connect) — NOT YET APPLIED.
create table if not exists public.tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  address text not null, chain text not null default 'eth',
  label text, kind text not null default 'own'
    check (kind in ('own','whale','treasury','smart','competitor')),
  portfolio_group text, created_at timestamptz not null default now(),
  unique (user_id, address, chain));
create index if not exists tracked_wallets_user on public.tracked_wallets (user_id);

alter table public.tracked_wallets enable row level security;
drop policy if exists tracked_own on public.tracked_wallets;
create policy tracked_own on public.tracked_wallets for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.tracked_wallets to authenticated;
grant select, insert, update, delete on public.tracked_wallets to service_role;
