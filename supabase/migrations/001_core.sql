create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  branch_id uuid references public.branches(id),
  full_name text not null,
  role text not null check (role in ('owner','admin','manager','cashier','production','readonly')),
  active boolean not null default true
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code text not null,
  name text not null,
  unit text not null check (unit in ('kg','unit','box')),
  cost numeric(14,2) not null default 0,
  price_retail numeric(14,2) not null default 0,
  min_stock numeric(14,3) not null default 0,
  active boolean not null default true,
  unique(company_id, code)
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  product_id uuid not null references public.products(id),
  movement_type text not null,
  quantity numeric(14,3) not null check (quantity <> 0),
  reference_type text,
  reference_id uuid,
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace view public.current_stock as
select company_id, branch_id, product_id, sum(quantity) quantity
from public.inventory_movements
group by company_id, branch_id, product_id;

create table if not exists public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  opened_by uuid not null references auth.users(id),
  status text not null check (status in ('open','closed')),
  opening_amount numeric(14,2) not null default 0,
  closing_counted numeric(14,2),
  difference numeric(14,2),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists one_open_cash_per_branch
on public.cash_sessions(branch_id) where status = 'open';

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  cash_session_id uuid not null references public.cash_sessions(id),
  payment_method text not null,
  total numeric(14,2) not null,
  cost_total numeric(14,2) not null,
  profit numeric(14,2) not null,
  status text not null default 'completed',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid not null references public.products(id),
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null,
  line_total numeric(14,2) not null,
  line_cost numeric(14,2) not null
);

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  branch_id uuid not null references public.branches(id),
  cash_session_id uuid not null references public.cash_sessions(id),
  direction text not null check (direction in ('in','out')),
  payment_method text not null,
  amount numeric(14,2) not null check (amount > 0),
  movement_type text not null,
  reference_type text,
  reference_id uuid,
  reason text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id),
  branch_id uuid references public.branches(id),
  user_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
