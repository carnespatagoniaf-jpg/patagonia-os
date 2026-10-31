-- Anular una venta de punta a punta (auditoría 29/10/2026). Dos ventas, se anula la primera: el stock vuelve, el
-- cierre cuenta solo la que quedó y la caja da justa. Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-00000000cb01', 'Anular', 9902, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-00000000cb02', '00000000-0000-0000-0000-00000000cb01', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000cb03', 'duenio@anular');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-00000000cb03', '00000000-0000-0000-0000-00000000cb01', '00000000-0000-0000-0000-00000000cb02', 'Dueño', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-00000000cb04', '00000000-0000-0000-0000-00000000cb01', '1', 'Vacío', 'kg', 9000, 15000);
insert into treasury_accounts (id, company_id, name, payment_method) values
  ('00000000-0000-0000-0000-00000000cb05', '00000000-0000-0000-0000-00000000cb01', 'Efectivo', 'cash');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000cb03', true);

do $$
declare
  r jsonb;
  v_shift uuid;
  v_sale uuid;
  v_close jsonb;
  v_br constant uuid := '00000000-0000-0000-0000-00000000cb02';
  v_p constant uuid := '00000000-0000-0000-0000-00000000cb04';
  v_cash constant uuid := '00000000-0000-0000-0000-00000000cb05';
begin
  r := public.open_pos_shift(v_br, 0);
  v_shift := (r ->> 'id')::uuid;
  r := public.create_pos_sale(v_br, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 2)),
    jsonb_build_array(jsonb_build_object('account_id', v_cash, 'amount', 30000)), v_shift, 0, 0, gen_random_uuid());
  v_sale := (r ->> 'sale_id')::uuid;
  r := public.create_pos_sale(v_br, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 1)),
    jsonb_build_array(jsonb_build_object('account_id', v_cash, 'amount', 15000)), v_shift, 0, 0, gen_random_uuid());

  -- Sin motivo no se anula.
  begin
    perform public.void_pos_sale(v_sale, '', null);
    raise exception 'se anuló sin motivo';
  exception when others then
    if sqlerrm = 'se anuló sin motivo' then raise; end if;
  end;

  r := public.void_pos_sale(v_sale, 'Se cobró dos veces', null);
  if not coalesce((r ->> 'ok')::boolean, false) then raise exception 'no se anuló: %', r; end if;
  if (select voided_at from pos_sales where id = v_sale) is null then raise exception 'la venta no quedó anulada'; end if;
  if (select sum(quantity) from inventory_movements where product_id = v_p) <> -1 then raise exception 'el stock no volvió'; end if;

  v_close := public.close_pos_shift(v_shift, 15000);
  if (v_close ->> 'total')::numeric <> 15000 or (v_close ->> 'difference')::numeric <> 0 then
    raise exception 'el cierre contó la venta anulada: %', v_close;
  end if;
end $$;

rollback;
