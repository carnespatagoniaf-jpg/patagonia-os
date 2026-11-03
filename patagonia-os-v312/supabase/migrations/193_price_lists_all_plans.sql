-- 193: precio mayorista para todos los planes (dueño, 2026-11-03: "tendría que dejar que cada uno ponga su precio y a
-- todos, sino lo estamos frenando"). La lista de precios (167) era de plan Full: solo save_price_list lo exigía
-- (require_plan('full')); el resto de las funciones y las tablas nunca miraron el plan. Se saca esa línea de la
-- definición viva (inyección, como 178/188), así Stock puede crear sola la lista "Mayorista" en cualquier plan.
-- Quién puede seguir igual: dueño/administrador (price_list_caller).

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.save_price_list(uuid, text, text, numeric, boolean)');
  v_def text;
  v_line text := E'  perform public.require_plan(''full'');\n';
begin
  if v_proc is null then
    raise notice '193: no está save_price_list: se saltea';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position(v_line in v_def) = 0 then
    raise notice '193: save_price_list ya no pide plan Full';
    return;
  end if;
  execute replace(v_def, v_line, '');
end
$mig$;

insert into public.schema_migrations (version) values ('193_price_lists_all_plans') on conflict do nothing;
