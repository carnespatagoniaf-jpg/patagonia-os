-- 118: Mostrador + balanza Systel: artículos leídos del "Reporte de ventas" de la balanza (función 72).
--
-- Por qué (real, Los gringos 13/10, ticket op. 20-3095): el ticket trae un solo código, el del TOTAL.
-- Mostrador lee el detalle de ese ticket en la balanza (producto, gramos/unidades, importe) y carga
-- cada artículo. El importe de cada artículo es el que cobró la BALANZA (puede no coincidir con el
-- precio de Patagonia, o el producto puede no tener precio cargado en Patagonia); la cantidad que se
-- descuenta del stock es la que pesó la balanza. El catálogo no se toca.
--
-- Cambios:
-- 1. pos_sale_items.scale_ticket: identidad del ticket de la balanza (balanza + fecha + N.º de ticket +
--    hora). Sirve para no cargar dos veces el mismo ticket, desde cualquier computadora.
-- 2. create_pos_sale (7 argumentos): un ítem de producto puede traer "scale_amount" (importe de la
--    balanza) SOLO si viene con source = 'scale' y con "scale_ticket". Entonces line_total = ese
--    importe (menos su descuento) y unit_price = importe / cantidad. Todo lo demás de la función queda
--    igual: se inyecta en la definición VIVA de cada base (como la 104), no se copia el cuerpo.
--    No es un permiso nuevo: quien vende en Mostrador ya puede cobrar artículos a mano a cualquier
--    precio y hacer descuentos.

alter table public.pos_sale_items add column if not exists scale_ticket text;

create index if not exists pos_sale_items_scale_ticket_idx
  on public.pos_sale_items (scale_ticket)
  where scale_ticket is not null;

do $mig$
declare
  v_def text;
  v_new text;
  v_step text;
  v_a1 constant text := '      v_line_total := (v_quantity * v_product.price_retail) - v_item_discount;';
  v_b1 constant text := '      v_line_total := (v_quantity * v_product.price_retail) - v_item_discount;
      -- 118: artículo leído del reporte de ventas de la balanza: vale el importe que cobró la balanza.
      if (v_item->>''scale_amount'') is not null then
        if public.pos_item_source(v_item->>''source'') is distinct from ''scale'' or nullif(trim(v_item->>''scale_ticket''), '''') is null then
          raise exception ''Importe de balanza sin ticket de balanza'';
        end if;
        if (v_item->>''scale_amount'')::numeric <= 0 then
          raise exception ''Importe de balanza inválido'';
        end if;
        v_line_total := (v_item->>''scale_amount'')::numeric - v_item_discount;
      end if;';
  v_a2 constant text := '      v_unit_price := v_product.price_retail;

      insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, source, scale_tickets)
      values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_item_discount, (v_quantity * v_unit_price) - v_item_discount, public.pos_item_source(v_item->>''source''), public.pos_item_scale_tickets(v_item->>''source'', v_item->>''scale_tickets''));';
  v_b2 constant text := '      v_unit_price := v_product.price_retail;
      v_line_total := (v_quantity * v_unit_price) - v_item_discount;
      -- 118: importe de la balanza (validado arriba): precio unitario = importe / cantidad.
      if (v_item->>''scale_amount'') is not null then
        v_unit_price := round((v_item->>''scale_amount'')::numeric / v_quantity, 2);
        v_line_total := (v_item->>''scale_amount'')::numeric - v_item_discount;
      end if;

      insert into public.pos_sale_items (sale_id, product_id, quantity, unit_price, discount_amount, line_total, source, scale_tickets, scale_ticket)
      values (v_sale_id, v_product.id, v_quantity, v_unit_price, v_item_discount, v_line_total, public.pos_item_source(v_item->>''source''), public.pos_item_scale_tickets(v_item->>''source'', v_item->>''scale_tickets''), nullif(trim(v_item->>''scale_ticket''), ''''));';
begin
  v_def := replace(pg_get_functiondef('public.create_pos_sale(uuid,jsonb,jsonb,uuid,numeric,numeric,uuid)'::regprocedure), E'\r\n', E'\n');
  if position('scale_amount' in v_def) > 0 then
    raise notice '118: create_pos_sale ya tiene scale_amount, no se cambia';
    return;
  end if;
  v_step := 'validación';
  if position(v_a1 in v_def) = 0 then raise exception '118: no se encontró el punto de %', v_step; end if;
  v_new := replace(v_def, v_a1, v_b1);
  v_step := 'inserción';
  if position(v_a2 in v_new) = 0 then raise exception '118: no se encontró el punto de %', v_step; end if;
  v_new := replace(v_new, v_a2, v_b2);
  execute v_new;
end
$mig$;

insert into public.schema_migrations (version) values ('118_pos_scale_ticket_lines') on conflict do nothing;
