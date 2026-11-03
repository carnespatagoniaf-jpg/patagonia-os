-- 191: Sucursales etapa 3, personas y papeles (2026-11-02, plan Empresa, migración 189). Maqueta aprobada el 02/11.
--
-- 1) Un usuario a cargo de VARIOS locales: profile_branches suma locales a profiles.branch_id (que sigue siendo
--    "el local donde arranca"). my_branch_allowed(local) es la única regla de "¿puede actuar por este local?":
--    dueño/administrador siempre; el resto, su local o uno de los que tiene a cargo (estos últimos solo con plan
--    Empresa). La usan Mercadería entre locales (190), Pedidos de clientes (187) y las balanzas del local (165),
--    que antes comparaban contra profiles.branch_id: se les cambia esa sola línea sobre la definición viva.
-- 2) Empleados que rotan: employee_branches. Su PIN de caja vale también en esos locales (pos_verify_cashier,
--    pos_cashier_required y list_pos_cashiers, inyectado igual). Sueldo y vales siguen en su local principal.
-- 3) Facturación por local: branch_fiscal_settings (punto de venta + domicilio). El CUIT y el certificado son
--    uno solo. Un trigger BEFORE INSERT en invoices pone el punto de venta y el domicilio del local cuando la
--    factura se pide (request_invoice / request_charge_invoice NO se tocan); la nota de crédito copia el
--    domicilio de su factura (su punto de venta ya lo copia arca_queue_credit_note). arca-invoice autoriza con
--    invoices.point_of_sale, así que no cambia; solo su acción "check" acepta un local para probar su punto.
-- Sin filas en estas tablas todo funciona como antes.

-- Tablas -----------------------------------------------------------------------------------------------------

create table if not exists public.profile_branches (
  company_id uuid not null references public.companies(id),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (profile_id, branch_id)
);

create table if not exists public.employee_branches (
  company_id uuid not null references public.companies(id),
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (employee_id, branch_id)
);

create table if not exists public.branch_fiscal_settings (
  branch_id uuid primary key references public.branches(id),
  company_id uuid not null references public.companies(id),
  point_of_sale integer not null check (point_of_sale between 1 and 99998),
  address text check (address is null or length(address) <= 200),
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_message text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- El domicilio del local que emitió (va impreso). null = el de los datos generales.
alter table public.invoices add column if not exists issuer_address text;

create index if not exists profile_branches_company_idx on public.profile_branches (company_id);
create index if not exists employee_branches_company_idx on public.employee_branches (company_id);
create index if not exists branch_fiscal_settings_company_idx on public.branch_fiscal_settings (company_id);

alter table public.profile_branches enable row level security;
alter table public.employee_branches enable row level security;
alter table public.branch_fiscal_settings enable row level security;
revoke all on public.profile_branches from anon, authenticated;
revoke all on public.employee_branches from anon, authenticated;
revoke all on public.branch_fiscal_settings from anon, authenticated;
grant select on public.profile_branches, public.employee_branches, public.branch_fiscal_settings to authenticated;

drop policy if exists profile_branches_company_read on public.profile_branches;
create policy profile_branches_company_read on public.profile_branches for select to authenticated
  using (company_id = public.current_company_id());
drop policy if exists employee_branches_company_read on public.employee_branches;
create policy employee_branches_company_read on public.employee_branches for select to authenticated
  using (company_id = public.current_company_id());
drop policy if exists branch_fiscal_settings_company_read on public.branch_fiscal_settings;
create policy branch_fiscal_settings_company_read on public.branch_fiscal_settings for select to authenticated
  using (company_id = public.current_company_id());

drop trigger if exists zz_accountant_readonly on public.profile_branches;
create trigger zz_accountant_readonly before insert or update or delete on public.profile_branches
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.employee_branches;
create trigger zz_accountant_readonly before insert or update or delete on public.employee_branches
  for each statement execute function public.accountant_readonly_guard();
drop trigger if exists zz_accountant_readonly on public.branch_fiscal_settings;
create trigger zz_accountant_readonly before insert or update or delete on public.branch_fiscal_settings
  for each statement execute function public.accountant_readonly_guard();

-- 1) ¿Puede actuar por este local? -------------------------------------------------------------------------------

create or replace function public.my_branch_allowed(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true
      and (
        p.role in ('owner', 'admin')
        or p.branch_id = p_branch_id
        or (public.company_plan_allows('empresa')
            and exists (select 1 from public.profile_branches pb where pb.profile_id = p.id and pb.branch_id = p_branch_id))
      )
  );
$$;
revoke all on function public.my_branch_allowed(uuid) from public, anon;
grant execute on function public.my_branch_allowed(uuid) to authenticated;

-- Mercadería entre locales (190): la regla vive acá.
create or replace function public.transfers_branch_allowed(p_role text, p_own_branch uuid, p_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_role in ('owner', 'admin') or (p_own_branch is not null and p_own_branch = p_branch) or public.my_branch_allowed(p_branch);
$$;
revoke all on function public.transfers_branch_allowed(text, uuid, uuid) from public, anon, authenticated;

-- Pedidos de clientes (187): el cajero y el encargado ven los de sus locales.
create or replace function public.orders_branch_visible(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active = true and p.role in ('manager', 'cashier')
  ) and public.my_branch_allowed(p_branch_id);
$$;
revoke all on function public.orders_branch_visible(uuid) from public, anon;
grant execute on function public.orders_branch_visible(uuid) to authenticated;

-- Las funciones que comparaban "v_branch is distinct from p_branch_id" (orders_caller, balanzas del local)
-- pasan a my_branch_allowed. Se cambia solo esa línea sobre la definición que tiene ESTA base.
do $$
declare
  v_fn record;
  v_def text;
  v_count integer := 0;
begin
  for v_fn in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%v_branch is distinct from p_branch_id%'
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    v_def := replace(v_def, 'v_branch is distinct from p_branch_id', 'not public.my_branch_allowed(p_branch_id)');
    execute v_def;
    v_count := v_count + 1;
  end loop;
  raise notice '191: % funciones pasaron a my_branch_allowed', v_count;
end $$;

create or replace function public.set_profile_branches(p_profile_id uuid, p_branch_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_target record;
  v_branch uuid;
  v_count integer := 0;
begin
  perform public.require_plan('empresa');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;
  select id, role, branch_id into v_target from public.profiles where id = p_profile_id and company_id = v_company_id;
  if v_target.id is null then raise exception 'Usuario inválido'; end if;
  if v_target.role in ('owner', 'admin', 'accountant') then
    raise exception 'El dueño, el administrador y el contador ya ven todos los locales';
  end if;
  if coalesce(array_length(p_branch_ids, 1), 0) > 100 then raise exception 'Demasiados locales'; end if;

  delete from public.profile_branches where profile_id = p_profile_id;
  foreach v_branch in array coalesce(p_branch_ids, '{}') loop
    if v_branch = v_target.branch_id then continue; end if;
    if not exists (select 1 from public.branches where id = v_branch and company_id = v_company_id and active) then
      raise exception 'Local inválido';
    end if;
    insert into public.profile_branches (company_id, profile_id, branch_id, created_by)
    values (v_company_id, p_profile_id, v_branch, v_user_id) on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'profile.branches', 'profile', p_profile_id::text, jsonb_build_object('branch_ids', p_branch_ids));
  return v_count;
end;
$$;
revoke all on function public.set_profile_branches(uuid, uuid[]) from public, anon;
grant execute on function public.set_profile_branches(uuid, uuid[]) to authenticated;

-- 2) Empleados que rotan ----------------------------------------------------------------------------------------

-- El PIN vale en su local y en los que tiene sumados (inyectado sobre la definición viva de cada una).
do $$
declare
  v_name text;
  v_def text;
  v_new text;
begin
  foreach v_name in array array['pos_cashier_required', 'pos_verify_cashier', 'list_pos_cashiers'] loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;
    if v_def is null then raise exception '191: falta la función %', v_name; end if;
    if v_def like '%employee_branches%' then continue; end if;
    v_new := replace(v_def, 'e.branch_id = p_branch_id',
      '(e.branch_id = p_branch_id or exists (select 1 from public.employee_branches eb where eb.employee_id = e.id and eb.branch_id = p_branch_id))');
    if v_new = v_def then raise exception '191: % no tiene el control de sucursal esperado', v_name; end if;
    execute v_new;
  end loop;
end $$;

create or replace function public.set_employee_branches(p_employee_id uuid, p_branch_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_main uuid;
  v_branch uuid;
  v_count integer := 0;
begin
  perform public.require_plan('empresa');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;
  select branch_id into v_main from public.employees where id = p_employee_id and company_id = v_company_id;
  if not found then raise exception 'Empleado inválido'; end if;
  if coalesce(array_length(p_branch_ids, 1), 0) > 100 then raise exception 'Demasiados locales'; end if;

  delete from public.employee_branches where employee_id = p_employee_id;
  foreach v_branch in array coalesce(p_branch_ids, '{}') loop
    if v_branch is not distinct from v_main then continue; end if;
    if not exists (select 1 from public.branches where id = v_branch and company_id = v_company_id and active) then
      raise exception 'Local inválido';
    end if;
    insert into public.employee_branches (company_id, employee_id, branch_id, created_by)
    values (v_company_id, p_employee_id, v_branch, v_user_id) on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'employee.branches', 'employee', p_employee_id::text, jsonb_build_object('branch_ids', p_branch_ids));
  return v_count;
end;
$$;
revoke all on function public.set_employee_branches(uuid, uuid[]) from public, anon;
grant execute on function public.set_employee_branches(uuid, uuid[]) to authenticated;

-- Dónde trabajó: turnos de Mostrador con ese cajero (PIN) y lo vendido, por local. Dueño/administrador.
create or replace function public.employee_branch_activity(p_employee_id uuid, p_from date, p_to date)
returns table (branch_id uuid, shifts integer, sales_total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;
  if not exists (select 1 from public.employees e where e.id = p_employee_id and e.company_id = v_company_id) then
    raise exception 'Empleado inválido';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Período inválido'; end if;

  return query
  select s.branch_id, count(distinct s.id)::integer,
         coalesce(sum(ps.total) filter (where ps.voided_at is null), 0)::numeric
  from public.pos_shifts s
  left join public.pos_sales ps on ps.pos_shift_id = s.id
  where s.company_id = v_company_id and s.cashier_employee_id = p_employee_id
    and (s.opened_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
  group by s.branch_id;
end;
$$;
revoke all on function public.employee_branch_activity(uuid, date, date) from public, anon;
grant execute on function public.employee_branch_activity(uuid, date, date) to authenticated;

-- 3) Facturación por local -------------------------------------------------------------------------------------

-- p_point_of_sale null = el local vuelve a usar el punto de venta y el domicilio generales.
create or replace function public.save_branch_fiscal_settings(p_branch_id uuid, p_point_of_sale integer, p_address text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_old public.branch_fiscal_settings%rowtype;
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
begin
  perform public.require_plan('empresa');
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Solo el dueño o un administrador'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and company_id = v_company_id) then
    raise exception 'Local inválido';
  end if;
  if v_address is not null and length(v_address) > 200 then raise exception 'El domicilio es muy largo'; end if;

  select * into v_old from public.branch_fiscal_settings where branch_id = p_branch_id;
  if p_point_of_sale is null then
    delete from public.branch_fiscal_settings where branch_id = p_branch_id;
  else
    if p_point_of_sale < 1 or p_point_of_sale > 99998 then raise exception 'Punto de venta inválido (1 a 99998)'; end if;
    if v_address is null then raise exception 'Poné el domicilio del local: va impreso en la factura'; end if;
    insert into public.branch_fiscal_settings (branch_id, company_id, point_of_sale, address, updated_by, updated_at)
    values (p_branch_id, v_company_id, p_point_of_sale, v_address, v_user_id, now())
    on conflict (branch_id) do update
      set point_of_sale = excluded.point_of_sale, address = excluded.address, updated_by = excluded.updated_by, updated_at = now(),
          -- Si cambia el número, la prueba anterior ya no vale.
          last_check_at = case when branch_fiscal_settings.point_of_sale = excluded.point_of_sale then branch_fiscal_settings.last_check_at end,
          last_check_ok = case when branch_fiscal_settings.point_of_sale = excluded.point_of_sale then branch_fiscal_settings.last_check_ok end,
          last_check_message = case when branch_fiscal_settings.point_of_sale = excluded.point_of_sale then branch_fiscal_settings.last_check_message end;
  end if;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_company_id, p_branch_id, v_user_id, 'fiscal.branch_settings', 'branch', p_branch_id::text,
    case when v_old.branch_id is null then null else jsonb_build_object('point_of_sale', v_old.point_of_sale, 'address', v_old.address) end,
    jsonb_build_object('point_of_sale', p_point_of_sale, 'address', v_address));
end;
$$;
revoke all on function public.save_branch_fiscal_settings(uuid, integer, text) from public, anon;
grant execute on function public.save_branch_fiscal_settings(uuid, integer, text) to authenticated;

-- Al pedir una factura de un local con datos propios: su punto de venta y su domicilio. La nota de crédito
-- lleva el domicilio de su factura. Solo plan Empresa (si la empresa baja de plan, vuelve a lo general).
create or replace function public.invoices_branch_fiscal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bfs public.branch_fiscal_settings%rowtype;
begin
  if new.kind = 'nota_credito' then
    if new.issuer_address is null and new.related_invoice_id is not null then
      select issuer_address into new.issuer_address from public.invoices where id = new.related_invoice_id;
    end if;
    return new;
  end if;
  if new.branch_id is null then return new; end if;
  if not exists (select 1 from public.companies c where c.id = new.company_id and public.plan_rank(c.plan) >= public.plan_rank('empresa')) then
    return new;
  end if;
  select * into v_bfs from public.branch_fiscal_settings where branch_id = new.branch_id and company_id = new.company_id;
  if v_bfs.branch_id is not null then
    new.point_of_sale := v_bfs.point_of_sale;
    new.issuer_address := coalesce(new.issuer_address, v_bfs.address);
  end if;
  return new;
end;
$$;
revoke all on function public.invoices_branch_fiscal() from public, anon, authenticated;

drop trigger if exists invoices_branch_fiscal on public.invoices;
create trigger invoices_branch_fiscal before insert on public.invoices
  for each row execute function public.invoices_branch_fiscal();

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('191_branch_people') on conflict do nothing;
