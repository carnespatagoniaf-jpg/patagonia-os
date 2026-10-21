-- Proveedores: detalle de la compra en la cuenta corriente + descuentos y
-- recargos (2026-10-21, pedido del dueño para Martínez, SOLO para él).
--
-- companies.supplier_adjustments (default false) prende las dos cosas en la
-- pantalla Compras. Se activa a mano por empresa:
--   update public.companies set supplier_adjustments = true where id = '<empresa>';
--
-- supplier_adjustments: un movimiento de la cuenta del proveedor sin plata ni
-- stock. amount > 0 = recargo (le debo más), amount < 0 = descuento (le debo
-- menos). Solo lectura por RLS; se escribe con add/delete_supplier_adjustment.
-- supplier_balance suma los ajustes al saldo (columna nueva al final).

alter table public.companies add column if not exists supplier_adjustments boolean not null default false;

create table if not exists public.supplier_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  supplier_id uuid not null references public.suppliers(id),
  adjustment_date date not null,
  amount numeric(14,2) not null check (amount <> 0),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists supplier_adjustments_supplier_idx on public.supplier_adjustments (supplier_id);
create index if not exists supplier_adjustments_company_idx on public.supplier_adjustments (company_id);

alter table public.supplier_adjustments enable row level security;
drop policy if exists supplier_adjustments_company_read on public.supplier_adjustments;
create policy supplier_adjustments_company_read on public.supplier_adjustments
  for select to authenticated using (company_id = (select public.current_company_id()));

create or replace view public.supplier_balance as
 select s.id as supplier_id,
    s.company_id,
    coalesce(p.total_purchases, 0::numeric) as total_purchases,
    coalesce(pay.total_payments, 0::numeric) as total_payments,
    coalesce(p.total_purchases, 0::numeric) + coalesce(adj.total_adjustments, 0::numeric) - coalesce(pay.total_payments, 0::numeric) as balance,
    coalesce(adj.total_adjustments, 0::numeric) as total_adjustments
   from public.suppliers s
     left join (select purchases.supplier_id, sum(purchases.total) as total_purchases
           from public.purchases
          where purchases.status = 'active'
          group by purchases.supplier_id) p on p.supplier_id = s.id
     left join (select supplier_payments.supplier_id, sum(supplier_payments.amount) as total_payments
           from public.supplier_payments
          group by supplier_payments.supplier_id) pay on pay.supplier_id = s.id
     left join (select supplier_adjustments.supplier_id, sum(supplier_adjustments.amount) as total_adjustments
           from public.supplier_adjustments
          group by supplier_adjustments.supplier_id) adj on adj.supplier_id = s.id
  where s.company_id = (select public.current_company_id());

create or replace function public.add_supplier_adjustment(
  p_supplier_id uuid,
  p_adjustment_date date,
  p_amount numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Solo el dueño, un administrador o un encargado carga descuentos o recargos';
  end if;
  if not exists (select 1 from public.companies where id = v_company_id and supplier_adjustments) then
    raise exception 'Esta empresa no tiene descuentos y recargos a proveedores';
  end if;
  if not exists (select 1 from public.suppliers where id = p_supplier_id and company_id = v_company_id) then
    raise exception 'Proveedor inválido';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'Ingresá un monto';
  end if;
  if p_adjustment_date is null then
    raise exception 'Ingresá una fecha';
  end if;

  insert into public.supplier_adjustments (company_id, supplier_id, adjustment_date, amount, notes, created_by)
  values (v_company_id, p_supplier_id, p_adjustment_date, round(p_amount, 2), nullif(trim(p_notes), ''), v_user_id)
  returning id into v_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'supplier_adjustment.create', 'supplier_adjustment', v_id::text,
    jsonb_build_object('supplier_id', p_supplier_id, 'date', p_adjustment_date, 'amount', round(p_amount, 2), 'notes', p_notes));
  return v_id;
end;
$$;

create or replace function public.delete_supplier_adjustment(p_adjustment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_row public.supplier_adjustments;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Solo el dueño, un administrador o un encargado borra descuentos o recargos';
  end if;

  select * into v_row from public.supplier_adjustments where id = p_adjustment_id and company_id = v_company_id for update;
  if v_row.id is null then
    raise exception 'Movimiento inválido';
  end if;
  delete from public.supplier_adjustments where id = p_adjustment_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, v_user_id, 'supplier_adjustment.delete', 'supplier_adjustment', p_adjustment_id::text, to_jsonb(v_row));
end;
$$;

revoke all on function public.add_supplier_adjustment(uuid, date, numeric, text) from public, anon;
revoke all on function public.delete_supplier_adjustment(uuid) from public, anon;
grant execute on function public.add_supplier_adjustment(uuid, date, numeric, text) to authenticated;
grant execute on function public.delete_supplier_adjustment(uuid) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('142_supplier_adjustments') on conflict do nothing;
