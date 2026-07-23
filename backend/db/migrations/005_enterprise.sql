-- 005 · Enterprise control layer — NOT YET APPLIED.
-- OAuth SSO works via Supabase Auth today; SAML/SCIM connect per-customer via sso_connections.
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(), name text not null, slug text unique not null,
  plan text not null default 'enterprise'
    check (plan in ('core','pro','elite','institute','enterprise')),
  seats_total int not null default 1, data_retention_days int not null default 365,
  created_at timestamptz not null default now());

create table if not exists public.org_members (
  org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner','admin','analyst','member','viewer')),
  seat_active boolean not null default true, desk text,
  invited_by uuid, created_at timestamptz not null default now(),
  primary key (org_id, user_id));
create index if not exists org_members_user on public.org_members (user_id);

create table if not exists public.entitlements (
  org_id uuid references public.organizations(id) on delete cascade,
  key text not null, value jsonb not null default 'true', primary key (org_id, key));

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid, user_id uuid, action text not null, target text,
  meta jsonb default '{}', created_at timestamptz not null default now());
create index if not exists audit_org_time on public.audit_log (org_id, created_at desc);

create table if not exists public.sso_connections (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  protocol text not null default 'oauth' check (protocol in ('oauth','saml','oidc')),
  status text not null default 'pending' check (status in ('pending','active','disabled')),
  metadata jsonb not null default '{}', updated_at timestamptz not null default now());

alter table public.organizations enable row level security;
alter table public.org_members   enable row level security;
alter table public.entitlements  enable row level security;
alter table public.audit_log     enable row level security;
alter table public.sso_connections enable row level security;

-- members can see their own membership + their org; writes are backend-only (service_role)
drop policy if exists org_member_self on public.org_members;
create policy org_member_self on public.org_members for select to authenticated using (user_id = auth.uid());
drop policy if exists org_read on public.organizations;
create policy org_read on public.organizations for select to authenticated
  using (exists (select 1 from public.org_members m where m.org_id = id and m.user_id = auth.uid()));

grant select on public.organizations, public.org_members, public.entitlements to authenticated;
grant select, insert, update, delete on
  public.organizations, public.org_members, public.entitlements,
  public.audit_log, public.sso_connections to service_role;
