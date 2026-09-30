-- 101 - Planes por empresa (Básico / Estándar / Full) y sus límites.
--
-- Qué incluye cada plan (decisión del dueño, 2026-09-29, PDF "Planes Patagonia OS"):
--   Básico   ($20.000): 1 sucursal, hasta 3 usuarios. Mostrador, Stock,
--                       Compras, Tesorería, Reportes, impresora, etiquetas,
--                       Importar (productos y proveedores).
--   Estándar ($39.000): hasta 2 sucursales y 8 usuarios. + Clientes (fiado),
--                       Empleados, Despiece, Recetas, Rentabilidad, Deudas,
--                       balanza por cable, chat de ayuda, Enviar a soporte.
--   Full     ($69.000): sin límites. + pantalla Sucursales (resumen,
--                       transferir stock, cuentas por sucursal) y ocultar
--                       secciones por persona.
-- Las empresas que ya existían quedan en 'full' (que a nadie le falte nada de
-- golpe; el dueño las cambia a mano, cliente por cliente).
--
-- Cómo se controla en la base (no solo en pantalla), sin ningún control
-- global en la entrada de la API (decisión del dueño: que un error nunca
-- pueda frenar a todas las empresas juntas):
-- 1) Cada función de una pantalla con plan arranca con
--      perform public.require_plan('estandar');   (o 'full')
--    Se agrega con el bloque de abajo sobre la definición QUE YA ESTÁ en cada
--    base (no se copian cuerpos de funciones de archivos viejos). Si más
--    adelante se reescribe una de estas funciones, esa línea tiene que seguir
--    siendo lo primero del cuerpo. Para ver cuáles la tienen:
--      select proname from pg_proc where prosrc like '%require_plan(%';
-- 2) Las tablas de esas pantallas tienen una política RLS "restrictiva": si
--    el plan no alcanza, se leen vacías y no se pueden escribir.
-- 3) Límites de sucursales y usuarios: triggers al crear (o reactivar) una
--    sucursal o un usuario. Nunca borran ni desactivan lo que ya existe.
--
-- Lo que NO se controla acá: la balanza por cable (va directo de la PC a la
-- balanza), los tildes de "Qué puede ver" por persona (van dentro de
-- update_staff_user, que se usa en todos los planes) y las vistas de saldos
-- customer_balance / creditor_balance (solo lectura). Esos se ocultan en pantalla.

alter table public.companies add column if not exists plan text not null default 'full';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'companies_plan_check') then
    alter table public.companies add constraint companies_plan_check check (plan in ('basico', 'estandar', 'full'));
  end if;
end $$;

-- Orden de los planes. Un valor desconocido cuenta como el más alto.
create or replace function public.plan_rank(p_plan text)
returns integer
language sql
immutable
as $$
  select case p_plan when 'basico' then 1 when 'estandar' then 2 when 'full' then 3 else 3 end;
$$;

create or replace function public.plan_display_name(p_plan text)
returns text
language sql
immutable
as $$
  select case p_plan when 'basico' then 'Básico' when 'estandar' then 'Estándar' when 'full' then 'Full' else p_plan end;
$$;

-- Límites de cada plan (null = sin límite). Un solo lugar para cambiarlos.
create or replace function public.plan_limits(p_plan text, out max_branches integer, out max_users integer)
language sql
immutable
as $$
  select
    case p_plan when 'basico' then 1 when 'estandar' then 2 else null end,
    case p_plan when 'basico' then 3 when 'estandar' then 8 else null end;
$$;

-- ¿El plan de la empresa del usuario actual alcanza? Sin perfil (admin de
-- plataforma, service role) no aplica: devuelve true.
create or replace function public.company_plan_allows(p_min text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select public.plan_rank(c.plan) >= public.plan_rank(p_min)
     from public.profiles p
     join public.companies c on c.id = p.company_id
     where p.id = auth.uid()),
    true
  );
$$;

create or replace function public.require_plan(p_min text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.company_plan_allows(p_min) then
    raise exception 'Esto está en el plan %. Pedíselo a Patagonia OS.', public.plan_display_name(p_min)
      using hint = 'plan_required:' || p_min;
  end if;
end;
$$;

revoke all on function public.plan_rank(text) from public;
revoke all on function public.plan_display_name(text) from public;
revoke all on function public.plan_limits(text) from public;
revoke all on function public.company_plan_allows(text) from public;
revoke all on function public.require_plan(text) from public;
grant execute on function public.plan_rank(text) to authenticated;
grant execute on function public.plan_display_name(text) to authenticated;
grant execute on function public.plan_limits(text) to authenticated;
grant execute on function public.company_plan_allows(text) to authenticated;
grant execute on function public.require_plan(text) to authenticated;

-- 1) Agregar la revisión del plan al principio de cada función (todas sus
--    versiones con ese nombre). Toma la definición actual de ESTA base y le
--    inserta una línea después del primer "begin" del cuerpo. Si una ya la
--    tiene, no la toca (se puede correr dos veces).
do $$
declare
  v_gate record;
  v_fn record;
  v_def text;
  v_body_start integer;
  v_head text;
  v_body text;
  v_new_body text;
begin
  for v_gate in
    select * from (values
      -- Clientes (fiado)
      ('create_customer', 'estandar'), ('update_customer', 'estandar'),
      ('create_customer_charge', 'estandar'), ('create_customer_charge_with_items', 'estandar'),
      ('update_customer_charge', 'estandar'), ('delete_customer_charge', 'estandar'),
      ('get_customer_charge_items', 'estandar'), ('register_customer_payment', 'estandar'),
      ('update_customer_payment', 'estandar'), ('delete_customer_payment', 'estandar'),
      ('import_customers', 'estandar'),
      -- Empleados y sueldos
      ('create_employee', 'estandar'), ('update_employee', 'estandar'),
      ('create_payroll_adjustment', 'estandar'), ('delete_payroll_adjustment', 'estandar'),
      ('close_payroll_liquidation', 'estandar'), ('delete_payroll_liquidation', 'estandar'),
      ('register_employee_vale_from_pos_shift', 'estandar'),
      -- Despiece
      ('save_carcass_batch', 'estandar'), ('delete_carcass_batch', 'estandar'),
      ('save_carcass_cut', 'estandar'), ('delete_carcass_cut', 'estandar'),
      ('save_carcass_cut_template', 'estandar'), ('delete_carcass_cut_template', 'estandar'),
      -- Recetas
      ('save_recipe', 'estandar'), ('apply_recipe_to_product', 'estandar'), ('delete_recipe', 'estandar'),
      -- Rentabilidad
      ('create_fixed_cost', 'estandar'), ('update_fixed_cost', 'estandar'),
      ('save_stock_count', 'estandar'), ('delete_stock_count', 'estandar'),
      ('close_profitability_period', 'estandar'),
      -- Deudas
      ('create_creditor', 'estandar'), ('update_creditor', 'estandar'),
      ('create_creditor_debt', 'estandar'), ('update_creditor_debt', 'estandar'), ('delete_creditor_debt', 'estandar'),
      ('register_creditor_payment', 'estandar'), ('update_creditor_payment', 'estandar'), ('delete_creditor_payment', 'estandar'),
      -- Balanzas
      ('submit_scale_support_report', 'estandar'),
      -- Sucursales (resumen, transferencias, cuentas por sucursal)
      ('get_branches_overview', 'full'), ('transfer_branch_stock', 'full'), ('set_treasury_account_branch', 'full')
    ) as g(fn_name, min_plan)
  loop
    for v_fn in
      select p.oid, l.lanname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and p.proname = v_gate.fn_name
    loop
      if v_fn.lanname <> 'plpgsql' then
        raise exception 'Plan: % no es plpgsql (%), revisar a mano', v_gate.fn_name, v_fn.lanname;
      end if;

      v_def := pg_get_functiondef(v_fn.oid);
      if v_def like '%require_plan(%' then
        continue;
      end if;

      -- El cuerpo empieza en el primer "$function$"; el primer "begin" que
      -- aparece ahí adentro es el del bloque principal (lo que va antes es
      -- el "declare").
      v_body_start := position('$function$' in v_def);
      if v_body_start = 0 then
        raise exception 'Plan: no encontré el cuerpo de %', v_gate.fn_name;
      end if;
      v_head := left(v_def, v_body_start - 1);
      v_body := substr(v_def, v_body_start);
      if v_body !~* '\mbegin\M' then
        raise exception 'Plan: no encontré el begin de %', v_gate.fn_name;
      end if;
      v_new_body := regexp_replace(
        v_body,
        '\mbegin\M',
        'begin' || chr(10) || '  perform public.require_plan(''' || v_gate.min_plan || ''');',
        'i'
      );
      execute v_head || v_new_body;
    end loop;
  end loop;
end $$;

-- 2) Tablas de esas pantallas: si el plan no alcanza, se leen vacías y no se
--    pueden escribir. "restrictive" = se suma a las políticas que ya hay
--    (company_id, rol), no las reemplaza.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'customers', 'customer_charges', 'customer_charge_items', 'customer_payments',
    'employees', 'payroll_adjustments', 'payroll_liquidations', 'payroll_liquidation_payments',
    'carcass_batches', 'carcass_cuts', 'carcass_cut_templates',
    'recipes', 'recipe_items',
    'fixed_costs', 'profitability_periods', 'stock_counts',
    'creditors', 'creditor_debts', 'creditor_payments'
  ]
  loop
    if to_regclass('public.' || v_table) is null then
      continue;
    end if;
    execute format('drop policy if exists plan_estandar on public.%I', v_table);
    execute format(
      'create policy plan_estandar on public.%I as restrictive for all to authenticated
         using ((select public.company_plan_allows(''estandar'')))
         with check ((select public.company_plan_allows(''estandar'')))',
      v_table
    );
  end loop;
end $$;

-- 3) Límites de sucursales y usuarios activos.
create or replace function public.enforce_branch_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_max integer;
  v_count integer;
begin
  if not new.active then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.active then
    return new;
  end if;

  select plan into v_plan from public.companies where id = new.company_id;
  select max_branches into v_max from public.plan_limits(v_plan);
  if v_max is null then
    return new;
  end if;

  select count(*) into v_count from public.branches
  where company_id = new.company_id and active and id <> new.id;
  if v_count >= v_max then
    raise exception 'Tu plan % permite hasta % sucursal(es). Para agregar otra, pedí un plan más alto a Patagonia OS.',
      public.plan_display_name(v_plan), v_max;
  end if;
  return new;
end;
$$;

drop trigger if exists branches_plan_limit on public.branches;
create trigger branches_plan_limit
before insert or update of active on public.branches
for each row execute function public.enforce_branch_limit();

create or replace function public.enforce_user_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_max integer;
  v_count integer;
begin
  if not new.active then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.active then
    return new;
  end if;

  select plan into v_plan from public.companies where id = new.company_id;
  select max_users into v_max from public.plan_limits(v_plan);
  if v_max is null then
    return new;
  end if;

  select count(*) into v_count from public.profiles
  where company_id = new.company_id and active and id <> new.id;
  if v_count >= v_max then
    raise exception 'Tu plan % permite hasta % usuarios. Para agregar otro, desactivá uno o pedí un plan más alto a Patagonia OS.',
      public.plan_display_name(v_plan), v_max;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_plan_limit on public.profiles;
create trigger profiles_plan_limit
before insert or update of active on public.profiles
for each row execute function public.enforce_user_limit();

revoke all on function public.enforce_branch_limit() from public;
revoke all on function public.enforce_user_limit() from public;

-- 4) Admin de plataforma: ver y cambiar el plan de cada cliente.
create or replace function public.set_company_plan(p_company_id uuid, p_plan text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_plan is null or p_plan not in ('basico', 'estandar', 'full') then
    raise exception 'Plan inválido';
  end if;

  update public.companies set plan = p_plan where id = p_company_id;
  if not found then
    raise exception 'Cliente inválido';
  end if;
end;
$$;

revoke all on function public.set_company_plan(uuid, text) from public;
grant execute on function public.set_company_plan(uuid, text) to authenticated;

create or replace function public.list_company_plans()
returns table (company_id uuid, plan text, active_branches integer, active_users integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  return query
  select c.id, c.plan,
    (select count(*)::integer from public.branches b where b.company_id = c.id and b.active),
    (select count(*)::integer from public.profiles p where p.company_id = c.id and p.active)
  from public.companies c;
end;
$$;

revoke all on function public.list_company_plans() from public;
grant execute on function public.list_company_plans() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('101_company_plans') on conflict do nothing;
