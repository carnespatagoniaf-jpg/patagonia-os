-- 104 - Control de balanza en el cierre de Mostrador + anular tickets de balanza.
-- Todos los planes (mejora del cierre de Mostrador, que ya existe).
--
-- La balanza (Kretz) imprime un "TOTAL DEL DIA": ventas en $, kilos y
-- tiques emitidos desde el último borrado. Al cerrar el turno se imprime y
-- se borra. Este control compara ese total con lo que Mostrador cobró
-- escaneando tickets de la balanza:
--     balanza − tickets anulados  =  vendido en Mostrador con tickets de balanza
-- 1) pos_sale_items.source: 'scale' (etiqueta de peso/precio escaneada) o
--    'scale_total' (ticket de total). scale_tickets: cuántos tickets
--    escaneados representa la línea (dos etiquetas del mismo producto van en
--    una sola línea). Lo manda Mostrador en cada ítem de create_pos_sale.
-- 2) scale_ticket_voids: tickets que salieron mal y se anularon escaneándolos
--    (quién, cuándo, cuánto). También sirve de control de los empleados.
--    Las ventas anuladas de Mostrador cuentan como tickets anulados.
-- 3) pos_shift_scale_controls: lo que se cargó del ticket de la balanza al
--    cerrar y lo que dio el sistema. Si un día se olvidaron de borrar la
--    balanza, el control siguiente abarca todos los turnos desde el último
--    borrado confirmado (nunca se cuenta dos veces).

alter table public.pos_sale_items
  add column if not exists source text,
  add column if not exists scale_tickets integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_sale_items_source_check') then
    alter table public.pos_sale_items add constraint pos_sale_items_source_check check (source is null or source in ('scale', 'scale_total'));
  end if;
end $$;

create or replace function public.pos_item_source(p_source text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_source in ('scale', 'scale_total') then p_source else null end;
$$;

create or replace function public.pos_item_scale_tickets(p_source text, p_count text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when public.pos_item_source(p_source) is null then null
    when p_count ~ '^[0-9]{1,6}$' then greatest(1, p_count::integer)
    else 1
  end;
$$;

revoke all on function public.pos_item_source(text) from public;
revoke all on function public.pos_item_scale_tickets(text, text) from public;
grant execute on function public.pos_item_source(text) to authenticated;
grant execute on function public.pos_item_scale_tickets(text, text) to authenticated;

-- create_pos_sale guarda source/scale_tickets de cada ítem. Se toca SOLO la
-- lista de columnas y valores de los dos insert en pos_sale_items, sobre la
-- definición que ya está en esta base (no se copia el cuerpo de un archivo
-- viejo). Si no encuentra exactamente lo esperado, frena (no adivina).
do $$
declare
  v_def text;
  v_new text;
  v_old_manual_cols constant text := 'insert into public.pos_sale_items (sale_id, product_id, description, quantity, unit_price, discount_amount, line_total)';
  v_old_manual_vals constant text := 'values (v_sale_id, null, v_description, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount);';
  v_old_product_cols constant text := 'insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total)';
  v_old_product_vals constant text := 'values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount);';
  v_extra_vals constant text := ', public.pos_item_source(v_item->>''source''), public.pos_item_scale_tickets(v_item->>''source'', v_item->>''scale_tickets''));';
begin
  if to_regprocedure('public.create_pos_sale(uuid,jsonb,jsonb,uuid,numeric,numeric,uuid)') is null then
    -- Staging estaba atrasado y no tenía esta versión (2026-09-29): se saltea ahí.
    raise notice 'create_pos_sale (7 parámetros) no existe en esta base: no se modifica';
    return;
  end if;
  v_def := pg_get_functiondef('public.create_pos_sale(uuid,jsonb,jsonb,uuid,numeric,numeric,uuid)'::regprocedure);
  if v_def like '%pos_item_source(%' then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_old_manual_cols, ''))) / length(v_old_manual_cols) <> 1
     or (length(v_def) - length(replace(v_def, v_old_manual_vals, ''))) / length(v_old_manual_vals) <> 1
     or (length(v_def) - length(replace(v_def, v_old_product_cols, ''))) / length(v_old_product_cols) <> 1
     or (length(v_def) - length(replace(v_def, v_old_product_vals, ''))) / length(v_old_product_vals) <> 1 then
    raise exception 'create_pos_sale no tiene la forma esperada; revisar a mano antes de aplicar la 104';
  end if;
  v_new := replace(v_def, v_old_manual_cols, replace(v_old_manual_cols, 'line_total)', 'line_total, source, scale_tickets)'));
  v_new := replace(v_new, v_old_manual_vals, left(v_old_manual_vals, length(v_old_manual_vals) - 2) || v_extra_vals);
  v_new := replace(v_new, v_old_product_cols, replace(v_old_product_cols, 'line_total)', 'line_total, source, scale_tickets)'));
  v_new := replace(v_new, v_old_product_vals, left(v_old_product_vals, length(v_old_product_vals) - 2) || v_extra_vals);
  execute v_new;
end $$;

create table if not exists public.scale_ticket_voids (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  pos_shift_id uuid not null references public.pos_shifts(id) on delete cascade,
  barcode text not null,
  plu text,
  product_id uuid references public.products(id) on delete set null,
  weight_kg numeric(14,3),
  amount numeric(14,2) not null check (amount >= 0),
  reason text,
  voided_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists scale_ticket_voids_shift_idx on public.scale_ticket_voids (pos_shift_id);

create table if not exists public.pos_shift_scale_controls (
  pos_shift_id uuid primary key references public.pos_shifts(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  scale_amount numeric(14,2) not null,
  scale_kg numeric(14,3),
  scale_tickets integer,
  scale_cleared boolean not null,
  system_amount numeric(14,2) not null,
  system_kg numeric(14,3) not null,
  system_tickets integer not null,
  voided_amount numeric(14,2) not null,
  voided_kg numeric(14,3) not null default 0,
  voided_tickets integer not null,
  shifts_covered uuid[] not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.scale_ticket_voids enable row level security;
alter table public.pos_shift_scale_controls enable row level security;
revoke all on public.scale_ticket_voids, public.pos_shift_scale_controls from anon, authenticated;
grant select on public.scale_ticket_voids, public.pos_shift_scale_controls to authenticated;

drop policy if exists scale_ticket_voids_read on public.scale_ticket_voids;
create policy scale_ticket_voids_read on public.scale_ticket_voids for select to authenticated
  using (company_id = public.current_company_id());
drop policy if exists pos_shift_scale_controls_read on public.pos_shift_scale_controls;
create policy pos_shift_scale_controls_read on public.pos_shift_scale_controls for select to authenticated
  using (company_id = public.current_company_id());

-- Quién puede usarlo: los mismos que venden en Mostrador (dueño, admin, cajero).
create or replace function public.scale_control_caller(p_pos_shift_id uuid, out company_id uuid, out branch_id uuid, out shift_status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;
  select p.company_id into v_company_id
  from public.profiles p
  where p.id = auth.uid() and p.active and p.role in ('owner', 'admin', 'cashier');
  if v_company_id is null then
    raise exception 'No autorizado';
  end if;
  select s.company_id, s.branch_id, s.status into company_id, branch_id, shift_status
  from public.pos_shifts s
  where s.id = p_pos_shift_id and s.company_id = v_company_id;
  if company_id is null then
    raise exception 'Turno inválido';
  end if;
end;
$$;

revoke all on function public.scale_control_caller(uuid) from public;
grant execute on function public.scale_control_caller(uuid) to authenticated;

create or replace function public.void_scale_ticket(
  p_pos_shift_id uuid,
  p_barcode text,
  p_plu text,
  p_product_id uuid,
  p_weight_kg numeric,
  p_amount numeric,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_id uuid;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);
  if v_ctx.shift_status <> 'open' then
    raise exception 'El turno ya está cerrado';
  end if;
  if coalesce(trim(p_barcode), '') = '' then
    raise exception 'Falta el código del ticket';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Importe inválido';
  end if;
  if p_product_id is not null and not exists (select 1 from public.products where id = p_product_id and company_id = v_ctx.company_id) then
    raise exception 'Producto inválido';
  end if;

  insert into public.scale_ticket_voids (company_id, branch_id, pos_shift_id, barcode, plu, product_id, weight_kg, amount, reason, voided_by)
  values (v_ctx.company_id, v_ctx.branch_id, p_pos_shift_id, left(trim(p_barcode), 60), left(p_plu, 20), p_product_id,
          p_weight_kg, round(p_amount, 2), nullif(left(trim(coalesce(p_reason, '')), 200), ''), auth.uid())
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_ctx.company_id, v_ctx.branch_id, auth.uid(), 'scale_ticket.void', 'scale_ticket_void', v_id::text,
          jsonb_build_object('barcode', p_barcode, 'amount', p_amount, 'weight_kg', p_weight_kg, 'pos_shift_id', p_pos_shift_id));

  return v_id;
end;
$$;

revoke all on function public.void_scale_ticket(uuid, text, text, uuid, numeric, numeric, text) from public;
grant execute on function public.void_scale_ticket(uuid, text, text, uuid, numeric, numeric, text) to authenticated;

-- Turnos que entran en el control de este turno: desde el último control
-- en que se confirmó que se borró la balanza. Si nunca hubo uno, solo este turno.
create or replace function public.scale_control_window(p_pos_shift_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_branch_id uuid;
  v_since timestamptz;
  v_ids uuid[];
begin
  select branch_id into v_branch_id from public.pos_shifts where id = p_pos_shift_id;

  select max(s.closed_at) into v_since
  from public.pos_shift_scale_controls c
  join public.pos_shifts s on s.id = c.pos_shift_id
  where c.branch_id = v_branch_id and c.scale_cleared and c.pos_shift_id <> p_pos_shift_id;

  if v_since is null then
    return array[p_pos_shift_id];
  end if;

  select array_agg(s.id order by s.opened_at) into v_ids
  from public.pos_shifts s
  where s.branch_id = v_branch_id
    and (s.id = p_pos_shift_id or (s.closed_at > v_since and s.opened_at <= (select opened_at from public.pos_shifts where id = p_pos_shift_id)));

  return coalesce(v_ids, array[p_pos_shift_id]);
end;
$$;

-- Funciones internas: SIN acceso directo (no chequean la empresa; las usan
-- get/save_scale_control). "from public" solo no alcanza en este proyecto:
-- authenticated recibe EXECUTE por los privilegios por defecto.
revoke all on function public.scale_control_window(uuid) from public, anon, authenticated;

create or replace function public.scale_control_totals(p_shift_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with items as (
    select i.quantity, i.unit_price, coalesce(i.scale_tickets, 1) as tickets, i.source, s.voided_at, pr.unit
    from public.pos_sale_items i
    join public.pos_sales s on s.id = i.sale_id
    left join public.products pr on pr.id = i.product_id
    where s.pos_shift_id = any(p_shift_ids) and i.source is not null
  )
  select jsonb_build_object(
    'system_amount', coalesce((select round(sum(quantity * unit_price), 2) from items where voided_at is null), 0),
    'system_kg', coalesce((select round(sum(quantity), 3) from items where voided_at is null and source = 'scale' and unit = 'kg'), 0),
    'system_tickets', coalesce((select sum(tickets) from items where voided_at is null), 0),
    'voided_amount',
      coalesce((select round(sum(amount), 2) from public.scale_ticket_voids where pos_shift_id = any(p_shift_ids)), 0)
      + coalesce((select round(sum(quantity * unit_price), 2) from items where voided_at is not null), 0),
    'voided_kg',
      coalesce((select round(sum(weight_kg), 3) from public.scale_ticket_voids where pos_shift_id = any(p_shift_ids)), 0)
      + coalesce((select round(sum(quantity), 3) from items where voided_at is not null and source = 'scale' and unit = 'kg'), 0),
    'voided_tickets',
      coalesce((select count(*) from public.scale_ticket_voids where pos_shift_id = any(p_shift_ids)), 0)
      + coalesce((select sum(tickets) from items where voided_at is not null), 0)
  );
$$;

revoke all on function public.scale_control_totals(uuid[]) from public, anon, authenticated;

create or replace function public.get_scale_control(p_pos_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_ids uuid[];
  v_saved public.pos_shift_scale_controls%rowtype;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);

  select * into v_saved from public.pos_shift_scale_controls where pos_shift_id = p_pos_shift_id;
  v_ids := coalesce(v_saved.shifts_covered, public.scale_control_window(p_pos_shift_id));

  return public.scale_control_totals(v_ids) || jsonb_build_object(
    'shifts', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'opened_at', s.opened_at, 'closed_at', s.closed_at) order by s.opened_at), '[]'::jsonb)
               from public.pos_shifts s where s.id = any(v_ids)),
    'saved', case when v_saved.pos_shift_id is null then null else jsonb_build_object(
      'scale_amount', v_saved.scale_amount, 'scale_kg', v_saved.scale_kg, 'scale_tickets', v_saved.scale_tickets,
      'scale_cleared', v_saved.scale_cleared, 'created_at', v_saved.created_at,
      'system_amount', v_saved.system_amount, 'system_kg', v_saved.system_kg, 'system_tickets', v_saved.system_tickets,
      'voided_amount', v_saved.voided_amount, 'voided_kg', v_saved.voided_kg, 'voided_tickets', v_saved.voided_tickets) end
  );
end;
$$;

revoke all on function public.get_scale_control(uuid) from public;
grant execute on function public.get_scale_control(uuid) to authenticated;

create or replace function public.save_scale_control(
  p_pos_shift_id uuid,
  p_scale_amount numeric,
  p_scale_kg numeric,
  p_scale_tickets integer,
  p_scale_cleared boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_ids uuid[];
  v_totals jsonb;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);
  if p_scale_amount is null or p_scale_amount < 0 then
    raise exception 'Cargá el total de ventas que imprimió la balanza';
  end if;
  if p_scale_kg is not null and p_scale_kg < 0 or p_scale_tickets is not null and p_scale_tickets < 0 then
    raise exception 'Valores de la balanza inválidos';
  end if;

  v_ids := public.scale_control_window(p_pos_shift_id);
  v_totals := public.scale_control_totals(v_ids);

  insert into public.pos_shift_scale_controls (
    pos_shift_id, company_id, branch_id, scale_amount, scale_kg, scale_tickets, scale_cleared,
    system_amount, system_kg, system_tickets, voided_amount, voided_kg, voided_tickets, shifts_covered, created_by
  ) values (
    p_pos_shift_id, v_ctx.company_id, v_ctx.branch_id, round(p_scale_amount, 2), p_scale_kg, p_scale_tickets, coalesce(p_scale_cleared, false),
    (v_totals->>'system_amount')::numeric, (v_totals->>'system_kg')::numeric, (v_totals->>'system_tickets')::integer,
    (v_totals->>'voided_amount')::numeric, (v_totals->>'voided_kg')::numeric, (v_totals->>'voided_tickets')::integer, v_ids, auth.uid()
  )
  on conflict (pos_shift_id) do update set
    scale_amount = excluded.scale_amount, scale_kg = excluded.scale_kg, scale_tickets = excluded.scale_tickets,
    scale_cleared = excluded.scale_cleared, system_amount = excluded.system_amount, system_kg = excluded.system_kg,
    system_tickets = excluded.system_tickets, voided_amount = excluded.voided_amount, voided_kg = excluded.voided_kg, voided_tickets = excluded.voided_tickets,
    shifts_covered = excluded.shifts_covered, created_by = excluded.created_by, created_at = now();

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_ctx.company_id, v_ctx.branch_id, auth.uid(), 'scale_control.save', 'pos_shift', p_pos_shift_id::text,
          jsonb_build_object('scale_amount', p_scale_amount, 'scale_kg', p_scale_kg, 'scale_tickets', p_scale_tickets,
                             'scale_cleared', p_scale_cleared, 'system', v_totals, 'shifts', to_jsonb(v_ids)));

  return public.get_scale_control(p_pos_shift_id);
end;
$$;

revoke all on function public.save_scale_control(uuid, numeric, numeric, integer, boolean) from public;
grant execute on function public.save_scale_control(uuid, numeric, numeric, integer, boolean) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('104_scale_close_control') on conflict do nothing;
