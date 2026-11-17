-- 201: "Paquetes" (157) con etiquetas de cajas (198): solo las cajas escaneadas restan.
--
-- Pedido del dueño (17/11/2026, Carplat): ver el stock en kilos Y en cajas, "como M2". En 157 cada renglón vendido de
-- un producto por kilo resta 1 paquete. Carplat vende el mismo corte en caja cerrada (etiqueta del frigorífico) y
-- suelto (balanza o a mano): lo suelto no puede restar una caja. Con la pantalla 'etiquetas_caja' prendida, solo resta
-- el renglón que Mostrador marcó como caja (pos_sale_items.scale_ticket = 'CAJA-<código>', sin importe; Mostrador lo
-- manda desde esta versión). Sin 'etiquetas_caja' (M2 y el resto) queda exactamente como en 157.
-- Anular la venta sigue devolviendo lo que restó (pos_sales_void_packages no cambia).

create or replace function public.pos_sale_items_packages()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_unit text;
  v_tracks boolean;
  v_count integer;
  v_boxes boolean;
begin
  if new.product_id is null then return null; end if;
  begin
    select unit, track_packages into v_unit, v_tracks from public.products where id = new.product_id;
    if not coalesce(v_tracks, false) then return null; end if;
    select 'etiquetas_caja' = any(c.features) into v_boxes
    from public.pos_sales s join public.companies c on c.id = s.company_id where s.id = new.sale_id;
    if coalesce(v_boxes, false) then
      -- Solo cajas: cada renglón de caja es una caja (Mostrador pone una por renglón).
      if coalesce(new.scale_ticket, '') not like 'CAJA-%' then return null; end if;
      v_count := 1;
    else
      v_count := case
        when coalesce(new.scale_tickets, 0) > 0 then new.scale_tickets
        when v_unit = 'kg' then 1
        else greatest(round(new.quantity)::integer, 1)
      end;
    end if;
    insert into public.product_package_moves (company_id, branch_id, product_id, delta, kind, reference_id, created_by)
    select s.company_id, s.branch_id, new.product_id, -v_count, 'venta', s.id, s.created_by
    from public.pos_sales s where s.id = new.sale_id;
  exception when others then
    null; -- un paquete sin contar es mejor que una venta frenada
  end;
  return null;
end;
$$;

insert into public.schema_migrations (version) values ('201_packages_only_boxes') on conflict do nothing;
