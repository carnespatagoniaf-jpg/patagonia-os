-- 182: Dos arreglos chicos de la auditoría 29/10/2026. No cambia ningún dato existente.
--
-- 1. update_purchase_item no miraba si la compra estaba anulada: editar un renglón de una compra anulada (Compras
--    muestra "Editar" igual) sumaba stock fantasma ("purchase_adjustment" de una compra que ya no existe).
-- 2. delete_customer_charge no bloqueaba el cargo: dos clics seguidos (o dos pestañas) devolvían el stock dos veces.
--    Ahora toma el cargo con FOR UPDATE: el segundo espera y, cuando el primero lo borró, da "Cargo inválido".
-- Se inyecta sobre las definiciones vivas (tienen require_plan y, desde la 178, require_role).

do $mig$
declare
  v_def text;
  v_a constant text := E'  if v_purchase_id is null then\n    raise exception ''Ítem de compra inválido'';\n  end if;\n';
  v_b constant text := E'  if v_purchase_id is null then\n    raise exception ''Ítem de compra inválido'';\n  end if;\n\n  if exists (select 1 from public.purchases where id = v_purchase_id and status <> ''active'') then\n    raise exception ''Esa compra está anulada: no se puede editar.'';\n  end if;\n';
begin
  v_def := replace(pg_get_functiondef('public.update_purchase_item'::regproc), E'\r\n', E'\n');
  if position('Esa compra está anulada' in v_def) > 0 then
    raise notice '182: update_purchase_item ya controla la anulación';
  elsif position(v_a in v_def) = 0 then
    raise exception '182: update_purchase_item no tiene el punto esperado (revisar a mano)';
  else
    execute replace(v_def, v_a, v_b);
  end if;
end
$mig$;

do $mig$
declare
  v_def text;
  v_a constant text := E'  if not exists (\n    select 1 from public.customer_charges where id = p_charge_id and company_id = v_company_id\n  ) then\n    raise exception ''Cargo inválido'';';
  v_b constant text := E'  perform 1 from public.customer_charges where id = p_charge_id and company_id = v_company_id for update;\n  if not found then\n    raise exception ''Cargo inválido'';';
begin
  v_def := replace(pg_get_functiondef('public.delete_customer_charge'::regproc), E'\r\n', E'\n');
  if position('and company_id = v_company_id for update;' in v_def) > 0 then
    raise notice '182: delete_customer_charge ya bloquea el cargo';
  elsif position(v_a in v_def) = 0 then
    raise exception '182: delete_customer_charge no tiene el punto esperado (revisar a mano)';
  else
    execute replace(v_def, v_a, v_b);
  end if;
end
$mig$;

insert into public.schema_migrations (version) values ('182_purchase_charge_guards') on conflict do nothing;
