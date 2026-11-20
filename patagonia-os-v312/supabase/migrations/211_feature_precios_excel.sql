-- 211: Pantalla a pedido 'precios_excel' (companies.features): bajar y subir en Excel los precios de cada local
-- (Sucursales → Precios por zona). Pedido de Della Finca (20/11/2026), por ahora solo para ellos (decisión del dueño).
-- Se prende desde el panel de plataforma ("Pantallas a pedido").
--
-- Solo web: guarda con las RPC de siempre (save_price_zone, set_product_list_prices), que ya validan empresa y rol.
-- Acá solo se suma la clave a la lista de set_company_feature, inyectada en la definición viva (como la 198),
-- así no se pisa una clave que se haya sumado después.

do $mig$
declare
  v_def text := pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure);
begin
  if position('''precios_excel''' in v_def) > 0 then return; end if;
  -- La lista termina en 'pedidos_tienda' o en 'etiquetas_caja' (staging quedó sin la 198 en esta función): se suma al final.
  if v_def !~ '''pedidos_tienda''(, ''etiquetas_caja'')?\)' then raise exception 'set_company_feature no tiene la lista esperada'; end if;
  execute regexp_replace(v_def, '(''pedidos_tienda''(, ''etiquetas_caja'')?)\)', '\1, ''precios_excel'')');
end
$mig$;

insert into public.schema_migrations (version) values ('211_feature_precios_excel') on conflict do nothing;
