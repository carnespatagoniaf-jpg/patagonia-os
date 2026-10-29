-- 173: pantalla a pedido "traer_balanza" (2026-10-29).
--
-- Mis balanzas → "Traer productos de la balanza": crea en Patagonia los
-- productos que la balanza tiene y Patagonia no (import_products sin
-- actualizar nada). Pedido de Quesar delicateses, que tiene todo cargado en la
-- balanza. Solo se agrega la clave a la lista de set_company_feature; el resto
-- es la web.

create or replace function public.set_company_feature(p_company_id uuid, p_feature text, p_enabled boolean)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_features text[];
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_feature is null or p_feature not in ('frigorifico', 'cuentas', 'gastos', 'reporte_ventas', 'ventas_detalle', 'paquetes', 'venta_ruta', 'costo_parejo', 'traer_balanza') then
    raise exception 'Pantalla inválida';
  end if;
  update public.companies
  set features = case
    when coalesce(p_enabled, false) then (select array(select distinct unnest(features || array[p_feature])))
    else array_remove(features, p_feature)
  end
  where id = p_company_id
  returning features into v_features;
  if not found then
    raise exception 'Cliente inválido';
  end if;
  return v_features;
end;
$$;

revoke all on function public.set_company_feature(uuid, text, boolean) from public, anon;
grant execute on function public.set_company_feature(uuid, text, boolean) to authenticated;

insert into public.schema_migrations (version) values ('173_feature_traer_balanza') on conflict do nothing;
