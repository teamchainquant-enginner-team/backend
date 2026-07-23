-- 004 · Personalized overview widgets — NOT YET APPLIED.
create table if not exists public.dashboard_layouts (
  user_id uuid not null, surface text not null default 'overview',
  widgets jsonb not null default '[]', updated_at timestamptz not null default now(),
  primary key (user_id, surface));
alter table public.dashboard_layouts enable row level security;
drop policy if exists layout_own on public.dashboard_layouts;
create policy layout_own on public.dashboard_layouts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.dashboard_layouts to authenticated;
grant select, insert, update, delete on public.dashboard_layouts to service_role;
