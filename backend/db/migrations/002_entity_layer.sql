-- 002 · Entity Layer (ChainQuant ID)  — NOT YET APPLIED to the live project.
-- Additive only. Prevents treating wrapped/bridged/related addresses as unrelated.
create table if not exists public.entities (
  id text primary key, name text not null, primary_symbol text,
  category text, coingecko_id text, created_at timestamptz not null default now());

create table if not exists public.entity_addresses (
  entity_id text references public.entities(id) on delete cascade,
  network text not null, address text not null,
  role text not null default 'token'
    check (role in ('token','wrapped','bridged','treasury','deployer','multisig','lp')),
  primary key (network, address));
create index if not exists entity_addr_entity on public.entity_addresses (entity_id);

create table if not exists public.entity_links (
  entity_id text references public.entities(id) on delete cascade,
  kind text not null, value text not null, meta jsonb default '{}',
  primary key (entity_id, kind, value));

alter table public.entities         enable row level security;
alter table public.entity_addresses enable row level security;
alter table public.entity_links     enable row level security;
drop policy if exists entities_read on public.entities;
create policy entities_read on public.entities for select to anon, authenticated using (true);
drop policy if exists entity_addr_read on public.entity_addresses;
create policy entity_addr_read on public.entity_addresses for select to anon, authenticated using (true);
drop policy if exists entity_links_read on public.entity_links;
create policy entity_links_read on public.entity_links for select to anon, authenticated using (true);

grant select on public.entities, public.entity_addresses, public.entity_links to anon, authenticated;
grant select, insert, update, delete on public.entities, public.entity_addresses, public.entity_links to service_role;

insert into public.entities (id, name, primary_symbol, category, coingecko_id) values
  ('cq:usd-coin','USD Coin','USDC','Stablecoin','usd-coin'),
  ('cq:ethereum','Ethereum','ETH','Layer 1','ethereum'),
  ('cq:wrapped-bitcoin','Wrapped Bitcoin','WBTC','Wrapped','wrapped-bitcoin')
on conflict (id) do nothing;
insert into public.entity_addresses (entity_id, network, address, role) values
  ('cq:usd-coin','eth','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','token'),
  ('cq:usd-coin','base','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','token'),
  ('cq:usd-coin','arbitrum','0xaf88d065e77c8cc2239327c5edb3a432268e5831','token'),
  ('cq:ethereum','eth','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2','wrapped'),
  ('cq:wrapped-bitcoin','eth','0x2260fac5e5542a773aa44fbcfedf7c193bc2c599','token')
on conflict (network, address) do nothing;
