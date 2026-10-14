-- Los gringos: productos que en su Systel se venden POR UNIDAD (tipo U, registros 62 reales del 14/10) y en Patagonia
-- figuran por kg. El 14/10 por la tarde el cliente ya pasó 21 de los 29 a "unidad" y armó sus presentaciones
-- (cajones = 15 kg, mayoristas, etc.). Quedan 8. Este script corrige SOLO 5 (62, 63, 66, 92, 93): no participan de
-- ninguna presentación. 30, 64 y 65 sí (31 = 5 × 30; 64 usa el stock del 65): cambiarlos cambia el sentido de esas
-- presentaciones, así que los decide el cliente.
-- NO EJECUTADO: requiere la autorización del dueño (producción).
-- Protecciones: solo cambia los que siguen por kg, sin stock_source, sin ser principal de otro, sin movimientos ni ventas.
do $$
declare
  v_company constant uuid := 'a2660765-99a4-4945-84a1-803b8913a71f';
  v_codes constant text[] := array['62','63','66','92','93'];
  v_p record;
  v_done int := 0;
  v_skipped text := '';
begin
  for v_p in
    select p.id, p.code, p.name, p.unit,
      (select count(*) from public.inventory_movements m where m.product_id = p.id) movs,
      (select count(*) from public.pos_sale_items i where i.product_id = p.id) sales,
      p.stock_source_id is not null or exists (select 1 from public.products q where q.stock_source_id = p.id) in_presentation
    from public.products p where p.company_id = v_company and p.code = any (v_codes)
  loop
    if v_p.unit <> 'kg' or v_p.movs > 0 or v_p.sales > 0 or v_p.in_presentation then
      v_skipped := v_skipped || format('%s (%s, unidad %s, movimientos %s, ventas %s); ', v_p.code, v_p.name, v_p.unit, v_p.movs, v_p.sales);
      continue;
    end if;
    update public.products set unit = 'unit' where id = v_p.id;
    insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (v_company, null, 'product.unit_from_scale', 'product', v_p.id::text, jsonb_build_object('unit', 'kg'), jsonb_build_object('unit', 'unit', 'motivo', 'Systel: se vende por unidad (registro 62 real 14/10)'));
    v_done := v_done + 1;
  end loop;
  raise notice 'Pasados a por unidad: %. Sin tocar: %', v_done, coalesce(nullif(v_skipped, ''), 'ninguno');
end $$;
