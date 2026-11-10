-- 197: precios por zona (192) para todos los planes. Dueño, 2026-11-10: un cliente pone un precio en un local y le
-- cambia en el otro, y "cada local puede tener precios distintos"; "todos los planes van a poder tener precios
-- diferenciados, pero van a tener que pagar el plus por sucursal" (el cobro ya es por local). La zona era de plan
-- Empresa: solo save_price_zone lo exigía (require_plan('empresa')); las tablas, la vista y el cobro en Mostrador
-- nunca miraron el plan. Se saca esa línea de la definición viva (inyección, como 193).
-- Quién puede seguir igual: dueño/administrador (price_list_caller). El resto de Sucursales etapa 4 (local nuevo
-- copiando otro, compra repartida) sigue de plan Empresa.

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.save_price_zone(uuid, text, numeric, uuid[])');
  v_def text;
  v_line text := E'  perform public.require_plan(''empresa'');\n';
begin
  if v_proc is null then
    raise notice '197: no está save_price_zone: se saltea';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position(v_line in v_def) = 0 then
    raise notice '197: save_price_zone ya no pide plan Empresa';
    return;
  end if;
  execute replace(v_def, v_line, '');
end
$mig$;

insert into public.schema_migrations (version) values ('197_price_zones_all_plans') on conflict do nothing;
