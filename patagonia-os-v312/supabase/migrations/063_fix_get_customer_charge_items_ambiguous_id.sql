-- Bug real encontrado en producción: get_customer_charge_items (060) declara
-- "returns table (id uuid, ...)", lo que crea una variable plpgsql llamada
-- "id" visible en toda la función -- y el "where id = v_user_id" (pensado
-- como profiles.id) quedaba ambiguo entre esa variable y la columna de la
-- tabla. Postgres lo rechazaba con "column reference id is ambiguous" cada
-- vez que se apretaba "Remito", así que ninguna entrega con detalle de
-- productos podía imprimirse. Se soluciona calificando la columna.
create or replace function public.get_customer_charge_items(p_charge_id uuid)
returns table (
  id uuid,
  product_name text,
  description text,
  quantity numeric,
  unit_price numeric,
  line_total numeric
)
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

  select profiles.company_id into v_company_id
  from public.profiles
  where profiles.id = v_user_id and profiles.active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if not exists (
    select 1 from public.customer_charges cc
    where cc.id = p_charge_id and cc.company_id = v_company_id
  ) then
    raise exception 'Cargo inválido';
  end if;

  return query
  select
    cci.id,
    coalesce(p.name, cci.description) as product_name,
    cci.description,
    cci.quantity,
    cci.unit_price,
    cci.line_total
  from public.customer_charge_items cci
  left join public.products p on p.id = cci.product_id
  where cci.charge_id = p_charge_id
  order by cci.created_at;
end;
$$;

revoke all on function public.get_customer_charge_items(uuid) from public;
grant execute on function public.get_customer_charge_items(uuid) to authenticated;
