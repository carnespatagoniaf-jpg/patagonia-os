-- Un día completo de caja, de punta a punta (auditoría 29/10/2026: "pruebas automáticas del cierre de caja").
-- Abrir con $10.000, vender $15.000 en efectivo y $7.500 por Mercado Pago, retirar $8.000, gastar $1.000 del cajón y
-- cerrar contando $15.500. Tiene que dar: esperado $16.000, faltante $500 anotado en Efectivo, cada venta en su
-- cuenta, el gasto en Efectivo y el stock 1,5 kg menos. Si un cambio futuro rompe cualquiera de estos números, CI
-- frena antes de publicar. Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-00000000ca01', 'Caja', 9901, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-00000000ca01', 'Centro');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000ca03', 'duenio@caja');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000ca02', 'Dueño', 'owner');
insert into products (id, company_id, code, name, unit, cost, price_retail) values
  ('00000000-0000-0000-0000-00000000ca04', '00000000-0000-0000-0000-00000000ca01', '1', 'Vacío', 'kg', 9000, 15000);
insert into treasury_accounts (id, company_id, name, payment_method) values
  ('00000000-0000-0000-0000-00000000ca05', '00000000-0000-0000-0000-00000000ca01', 'Efectivo', 'cash'),
  ('00000000-0000-0000-0000-00000000ca06', '00000000-0000-0000-0000-00000000ca01', 'Mercado Pago', 'transfer');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ca03', true);

do $$
declare
  r jsonb;
  v_shift uuid;
  v_exp jsonb;
  v_close jsonb;
  v_cash constant uuid := '00000000-0000-0000-0000-00000000ca05';
  v_mp constant uuid := '00000000-0000-0000-0000-00000000ca06';
  v_br constant uuid := '00000000-0000-0000-0000-00000000ca02';
  v_p constant uuid := '00000000-0000-0000-0000-00000000ca04';
begin
  r := public.open_pos_shift(v_br, 10000);
  v_shift := (r ->> 'id')::uuid;
  r := public.create_pos_sale(v_br, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 1)),
    jsonb_build_array(jsonb_build_object('account_id', v_cash, 'amount', 15000)), v_shift, 0, 0, gen_random_uuid());
  r := public.create_pos_sale(v_br, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 0.5)),
    jsonb_build_array(jsonb_build_object('account_id', v_mp, 'amount', 7500, 'reference', 'op123')), v_shift, 0, 0, gen_random_uuid());
  r := public.register_pos_safe_deposit(v_shift, 8000);
  r := public.register_pos_shift_expense(v_shift, 1000, 'insumos', 'Lavandina');

  v_exp := public.pos_shift_expected(v_shift);
  if (v_exp ->> 'cash_expected')::numeric <> 16000 then raise exception 'efectivo esperado: %', v_exp; end if;

  v_close := public.close_pos_shift(v_shift, 15500);
  if (v_close ->> 'difference')::numeric <> -500 then raise exception 'diferencia al cerrar: %', v_close; end if;
  if (v_close ->> 'total')::numeric <> 22500 then raise exception 'total vendido: %', v_close; end if;

  if (select status from pos_shifts where id = v_shift) <> 'closed' then raise exception 'el turno no quedó cerrado'; end if;
  if not exists (select 1 from treasury_movements where account_id = v_cash and movement_type = 'venta' and direction = 'in' and amount = 15000) then
    raise exception 'la venta en efectivo no llegó a Tesorería';
  end if;
  if not exists (select 1 from treasury_movements where account_id = v_mp and movement_type = 'venta' and direction = 'in' and amount = 7500) then
    raise exception 'la venta por Mercado Pago no llegó a Tesorería';
  end if;
  if not exists (select 1 from treasury_movements where account_id = v_cash and movement_type = 'gasto' and direction = 'out' and amount = 1000) then
    raise exception 'el gasto del local no salió de Efectivo';
  end if;
  if not exists (select 1 from treasury_movements where account_id = v_cash and movement_type = 'ajuste' and direction = 'out' and amount = 500 and reference_type = 'pos_shift_close') then
    raise exception 'el faltante de caja no quedó anotado en Efectivo';
  end if;
  if (select sum(quantity) from inventory_movements where product_id = v_p) <> -1.5 then
    raise exception 'el stock no bajó 1,5 kg';
  end if;
end $$;

rollback;
