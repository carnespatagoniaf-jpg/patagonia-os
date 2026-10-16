-- 128: los reportes automáticos de "Mi balanza" llegan a soporte con cualquier usuario de la empresa.
--
-- Por qué: el 16/10 la Report LT de Carnes Patagonia (Haedo) no conectaba desde "Mi balanza" y no llegó
-- ningún reporte: en la PC del local estaba abierta la sesión del cajero, y submit_scale_support_report
-- solo aceptaba owner/admin. El reporte no tiene ventas, precios ni datos de clientes (solo el intercambio
-- con la balanza), y sigue el tope de 20 por empresa por día.
--
-- Se saca SOLO el chequeo de rol sobre la definición viva de cada base (staging y prod derivaron antes),
-- así no se pisa nada más de la función. La línea de require_plan queda primera, como estaba.

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.submit_scale_support_report(text,text,jsonb,text,uuid)'::regprocedure);
  v_new := regexp_replace(
    v_def,
    E'\\n\\s*if v_role not in \\(''owner'', ''admin''\\) then\\n\\s*raise exception ''No autorizado'';\\n\\s*end if;',
    '',
    ''
  );
  if v_new = v_def then
    raise notice 'submit_scale_support_report: no tenía el chequeo de rol, no se cambia';
  else
    execute v_new;
  end if;
end;
$$;

insert into public.schema_migrations (version) values ('128_scale_report_any_role') on conflict do nothing;
