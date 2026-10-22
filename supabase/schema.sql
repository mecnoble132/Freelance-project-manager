-- Client Ledger: tables and row-level security.
-- Run the whole file in the Supabase SQL editor. It is safe to run again, and adds new columns to an existing database.
-- Every row belongs to the signed-in user who created it, and only that user can read or change it.

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  contact text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.txns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  type text not null check (type in ('in', 'out')),
  amount numeric(12, 2) not null check (amount > 0),
  note text not null default '',
  date date,
  created_at timestamptz not null default now()
);

-- Dashboard fields (added later). Safe to run again on an existing database.
alter table public.clients add column if not exists notes text not null default '';

alter table public.projects add column if not exists status text not null default 'active';
alter table public.projects add column if not exists description text not null default '';
alter table public.projects add column if not exists quoted numeric(12, 2) not null default 0;
alter table public.projects add column if not exists preview_url text not null default '';
alter table public.projects add column if not exists live_url text not null default '';
alter table public.projects add column if not exists github_url text not null default '';
alter table public.projects add column if not exists start_date date;
alter table public.projects add column if not exists due_date date;
alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check check (status in ('lead', 'active', 'paused', 'done'));
alter table public.projects drop constraint if exists projects_quoted_check;
alter table public.projects add constraint projects_quoted_check check (quoted >= 0);

alter table public.txns add column if not exists category text not null default '';

create index if not exists clients_user_idx on public.clients (user_id);
create index if not exists projects_user_idx on public.projects (user_id);
create index if not exists txns_user_idx on public.txns (user_id);
create index if not exists projects_client_idx on public.projects (client_id);
create index if not exists txns_client_idx on public.txns (client_id);
create index if not exists txns_project_idx on public.txns (project_id);

alter table public.clients enable row level security;
alter table public.projects enable row level security;
alter table public.txns enable row level security;

drop policy if exists "own clients" on public.clients;
create policy "own clients" on public.clients
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own txns" on public.txns;
create policy "own txns" on public.txns
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Every change made through the MCP server (AI assistant), so it can be listed and undone.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  batch_id uuid not null,
  seq integer not null default 0,
  source text not null default 'mcp',
  summary text not null default '',
  op text not null check (op in ('insert', 'update', 'delete')),
  table_name text not null check (table_name in ('clients', 'projects', 'txns')),
  row_id uuid not null,
  before jsonb,
  after jsonb,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_user_idx on public.activity_log (user_id, created_at desc);
create index if not exists activity_log_batch_idx on public.activity_log (batch_id);
alter table public.activity_log enable row level security;
drop policy if exists "own activity" on public.activity_log;
create policy "own activity" on public.activity_log
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
