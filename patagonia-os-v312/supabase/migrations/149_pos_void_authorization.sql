-- Anular ventas de Mostrador con PIN de autorización y motivo (pedido del
-- dueño, 2026-10-22: "en la caja se pueden anular los tickets que ya se
-- vendieron, una cajera puede borrar una venta").
--
-- Hasta ahora cualquier usuario podía anular una venta del turno abierto sin
-- nada más que un "¿Seguro?". La venta deja de contar en la caja, así que una
-- venta cobrada en efectivo y anulada después cierra la caja justa sin la plata.
-- Sacarle el permiso a un rol no alcanzaba: en los negocios las cajeras usan el
-- mismo usuario admin que el dueño (se las distingue por el PIN de cajera, 117).
--
-- 1) PIN de autorización por empresa (company_void_pins, hash bcrypt, tabla
--    sin policies). Lo pone el dueño desde Mostrador → Control de caja. Para
--    cambiarlo o sacarlo hay que saber el actual (si no, la cajera con el
--    usuario compartido lo cambiaría). Si se olvida, lo borra soporte.
-- 2) void_pos_sale(p_sale_id, p_reason, p_auth_pin) pide motivo siempre y, si
--    la empresa tiene PIN, el PIN. Un PIN mal puesto devuelve {ok:false} en vez
--    de un error, para que el intento fallido quede guardado
--    (pos_void_pin_failures): 5 fallos en 15 minutos traban la anulación 15
--    minutos. Sin PIN cargado anula como antes, pero con motivo y a la vista
--    del dueño. La versión vieja (un solo parámetro) se reemplaza: una pestaña
--    sin recargar recibe "recargá la página".
-- 3) pos_sales.void_reason / void_authorized + list_pos_voided_sales para el
--    detalle de anuladas en Control de caja (dueño/admin).
-- 4) Nadie escribe pos_sales / pos_sale_items / pos_sale_payments directo por
--    la API: todas las altas y cambios ya iban por funciones security definer
--    (create_pos_sale, void_pos_sale, change_pos_sale_payment_account). Sin
--    esto el PIN se podía saltear marcando voided_at a mano.
--
-- Para todos los planes (es un arreglo, no una pantalla nueva).

-- 1) Tablas -------------------------------------------------------------------

create table if not exists public.company_void_pins (
  company_id uuid primary key references public.companies(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.company_void_pins enable row level security;
revoke all on public.company_void_pins from anon, authenticated;

create table if not exists public.pos_void_pin_failures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists pos_void_pin_failures_idx on public.pos_void_pin_failures (company_id, created_at desc);
alter table public.pos_void_pin_failures enable row level security;
revoke all on public.pos_void_pin_failures from anon, authenticated;

alter table public.pos_sales add column if not exists void_reason text;
alter table public.pos_sales add column if not exists void_authorized boolean not null default false;

-- 4) Sin escrituras directas a las ventas ---------------------------------------
revoke insert, update, delete, truncate on public.pos_sales from anon, authenticated;
revoke insert, update, delete, truncate on public.pos_sale_items from anon, authenticated;
revoke insert, update, delete, truncate on public.pos_sale_payments from anon, authenticated;

-- 2) Helpers internos (no expuestos) -----------------------------------------

create or replace function public.pos_void_pin_locked(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) >= 5
  from public.pos_void_pin_failures
  where company_id = p_company_id and created_at > now() - interval '15 minutes';
$$;
revoke all on function public.pos_void_pin_locked(uuid) from public, anon, authenticated;

-- ¿El PIN coincide? null = la empresa no tiene PIN.
create or replace function public.pos_void_pin_matches(p_company_id uuid, p_pin text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select pin_hash into v_hash from public.company_void_pins where company_id = p_company_id;
  if v_hash is null then return null; end if;
  return p_pin is not null and extensions.crypt(trim(p_pin), v_hash) = v_hash;
end;
$$;
revoke all on function public.pos_void_pin_matches(uuid, text) from public, anon, authenticated;

-- 3) Funciones expuestas -------------------------------------------------------

create or replace function public.has_pos_void_pin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.company_void_pins where company_id = public.current_company_id());
$$;
revoke all on function public.has_pos_void_pin() from public, anon;
grant execute on function public.has_pos_void_pin() to authenticated;

create or replace function public.set_pos_void_pin(p_current_pin text, p_new_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_new text := nullif(trim(coalesce(p_new_pin, '')), '');
  v_matches boolean;
begin
  select company_id, role into v_company_id, v_role
  from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador puede cambiar el PIN de autorización'; end if;

  perform pg_advisory_xact_lock(hashtext('pos_void_pin:' || v_company_id::text));

  v_matches := public.pos_void_pin_matches(v_company_id, p_current_pin);
  if v_matches is not null then
    if public.pos_void_pin_locked(v_company_id) then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
    end if;
    if not v_matches then
      insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
      return jsonb_build_object('ok', false, 'error', 'Ese no es el PIN actual.');
    end if;
  elsif v_new is null then
    return jsonb_build_object('ok', true);
  end if;

  if v_new is null then
    delete from public.company_void_pins where company_id = v_company_id;
  else
    if v_new !~ '^[0-9]{4,6}$' then raise exception 'El PIN tiene que ser de 4 a 6 números'; end if;
    insert into public.company_void_pins (company_id, pin_hash, updated_at, updated_by)
    values (v_company_id, extensions.crypt(v_new, extensions.gen_salt('bf')), now(), v_user_id)
    on conflict (company_id) do update set pin_hash = excluded.pin_hash, updated_at = now(), updated_by = v_user_id;
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'pos_void_pin.set', 'company', v_company_id::text,
          jsonb_build_object('has_pin', v_new is not null));

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.set_pos_void_pin(text, text) from public, anon;
grant execute on function public.set_pos_void_pin(text, text) to authenticated;

drop function if exists public.void_pos_sale(uuid);

create or replace function public.void_pos_sale(p_sale_id uuid, p_reason text default null, p_auth_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sale public.pos_sales%rowtype;
  v_shift public.pos_shifts%rowtype;
  v_item record;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_matches boolean;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id into v_company_id
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_reason is null then
    raise exception 'Para anular hay que elegir el motivo. Si no aparece, recargá la página (F5).';
  end if;

  select * into v_sale
  from public.pos_sales
  where id = p_sale_id and company_id = v_company_id
  for update;

  if not found then
    raise exception 'Venta inválida';
  end if;

  if v_sale.voided_at is not null then
    raise exception 'Esa venta ya está anulada';
  end if;

  select * into v_shift from public.pos_shifts where id = v_sale.pos_shift_id;

  if v_shift.status <> 'open' then
    raise exception 'No se puede anular: el turno ya está cerrado';
  end if;

  v_matches := public.pos_void_pin_matches(v_company_id, p_auth_pin);
  if v_matches is not null then
    if public.pos_void_pin_locked(v_company_id) then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con el PIN equivocado. Esperá 15 minutos.');
    end if;
    if not v_matches then
      insert into public.pos_void_pin_failures (company_id, created_by) values (v_company_id, v_user_id);
      return jsonb_build_object('ok', false, 'error', 'PIN de autorización incorrecto.');
    end if;
  end if;

  for v_item in
    select product_id, quantity from public.pos_sale_items
    where sale_id = p_sale_id and product_id is not null
  loop
    insert into public.inventory_movements (
      company_id, branch_id, product_id, movement_type, quantity,
      reference_type, reference_id, reason, created_by
    ) values (
      v_company_id, v_sale.branch_id, v_item.product_id, 'sale_void', v_item.quantity,
      'pos_sale_void', p_sale_id, 'Anulación de venta de mostrador', v_user_id
    );
  end loop;

  update public.pos_sales
  set voided_at = now(), voided_by = v_user_id,
      void_reason = left(v_reason, 200), void_authorized = coalesce(v_matches, false)
  where id = p_sale_id;

  insert into public.audit_log (
    company_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_sale.branch_id, v_user_id, 'pos_sale.void', 'pos_sale', p_sale_id::text,
    jsonb_build_object('reason', left(v_reason, 200), 'authorized', coalesce(v_matches, false), 'total', v_sale.total)
  );

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.void_pos_sale(uuid, text, text) from public, anon;
grant execute on function public.void_pos_sale(uuid, text, text) to authenticated;

-- Detalle de anuladas para el dueño (Control de caja). p_branch_id null = todas.
create or replace function public.list_pos_voided_sales(p_branch_id uuid default null, p_days integer default 14)
returns table (
  id uuid,
  sold_at timestamptz,
  voided_at timestamptz,
  total numeric,
  reason text,
  authorized boolean,
  voided_by_name text,
  cashier_name text,
  items text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
begin
  select p.company_id, p.role into v_company_id, v_role
  from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador ve las ventas anuladas'; end if;

  return query
  select s.id, s.created_at, s.voided_at, s.total, s.void_reason, s.void_authorized,
    vp.full_name,
    coalesce(e.full_name, cp.full_name),
    (select string_agg(coalesce(pr.name, i.description, 'Producto'), ', ' order by i.id)
       from public.pos_sale_items i left join public.products pr on pr.id = i.product_id
      where i.sale_id = s.id)
  from public.pos_sales s
  left join public.pos_shifts sh on sh.id = s.pos_shift_id
  left join public.employees e on e.id = sh.cashier_employee_id
  left join public.profiles vp on vp.id = s.voided_by
  left join public.profiles cp on cp.id = s.created_by
  where s.company_id = v_company_id
    and s.voided_at is not null
    and s.voided_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90)))
    and (p_branch_id is null or s.branch_id = p_branch_id)
  order by s.voided_at desc
  limit 300;
end;
$$;
revoke all on function public.list_pos_voided_sales(uuid, integer) from public, anon;
grant execute on function public.list_pos_voided_sales(uuid, integer) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('149_pos_void_authorization') on conflict do nothing;
