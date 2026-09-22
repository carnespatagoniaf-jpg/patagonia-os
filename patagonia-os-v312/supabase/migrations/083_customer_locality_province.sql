-- Se agrega localidad y provincia al cliente (cuenta corriente) -- mismo
-- patrón que phone/notes, campos de texto libre opcionales.
alter table public.customers add column if not exists locality text;
alter table public.customers add column if not exists province text;

drop function if exists public.create_customer(uuid, text, text, text);

create function public.create_customer(
  p_branch_id uuid,
  p_name text,
  p_phone text default null,
  p_notes text default null,
  p_locality text default null,
  p_province text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_id uuid := gen_random_uuid();
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  insert into public.customers (id, company_id, branch_id, name, phone, notes, locality, province)
  values (
    v_id, v_company_id, p_branch_id, trim(p_name),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    nullif(trim(coalesce(p_locality, '')), ''),
    nullif(trim(coalesce(p_province, '')), '')
  );

  return jsonb_build_object('id', v_id);
end;
$$;

revoke all on function public.create_customer(uuid,text,text,text,text,text) from public;
grant execute on function public.create_customer(uuid,text,text,text,text,text) to authenticated;

drop function if exists public.update_customer(uuid, text, text, text, int, boolean);

create function public.update_customer(
  p_customer_id uuid,
  p_name text,
  p_phone text default null,
  p_notes text default null,
  p_payment_term_days int default null,
  p_active boolean default true,
  p_locality text default null,
  p_province text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre es obligatorio';
  end if;

  if p_payment_term_days is not null and p_payment_term_days <= 0 then
    raise exception 'El plazo tiene que ser mayor que cero';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and company_id = v_company_id for update
  ) then
    raise exception 'Cliente inválido';
  end if;

  update public.customers
  set
    name = trim(p_name),
    phone = nullif(trim(coalesce(p_phone, '')), ''),
    notes = nullif(trim(coalesce(p_notes, '')), ''),
    payment_term_days = p_payment_term_days,
    active = p_active,
    locality = nullif(trim(coalesce(p_locality, '')), ''),
    province = nullif(trim(coalesce(p_province, '')), '')
  where id = p_customer_id;

  insert into public.audit_log (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_company_id, v_user_id, 'customer.update', 'customer', p_customer_id::text,
    jsonb_build_object('name', p_name, 'payment_term_days', p_payment_term_days, 'active', p_active)
  );

  return jsonb_build_object('id', p_customer_id);
end;
$$;

revoke all on function public.update_customer(uuid,text,text,text,int,boolean,text,text) from public;
grant execute on function public.update_customer(uuid,text,text,text,int,boolean,text,text) to authenticated;
