-- 178: Las funciones sensibles controlan el ROL de quien las llama (auditoría 29/10/2026, segunda mitad de C1).
--
-- La 175 cerró la escritura directa en las tablas, pero varias funciones solo miraban que el usuario fuera de la
-- empresa: un cajero, con el token de su sesión, podía llamarlas por la API aunque la pantalla no se las mostrara
-- (ajustar el saldo de una cuenta, cambiar un precio, poner el stock en cualquier número, borrar un cobro de fiado).
-- Ahora cada una exige los mismos roles que hoy tienen la pantalla donde se usa (permissions.ts):
--   Tesorería (treasury.manage): dueño, administrador
--     adjust_treasury_account, transfer_treasury_funds
--   Stock (editar productos / ajustar stock): dueño, administrador, encargado, producción
--     update_product, set_product_active, delete_product, set_products_vat_rate, adjust_product_stock
--     (el rol "solo lectura" veía Stock y la pantalla le dejaba editar: ya no)
--   Compras (purchases.manage): dueño, administrador, encargado
--     void_purchase, update_purchase_item
--   Clientes (customers.manage): dueño, administrador
--     update_customer_payment, delete_customer_payment, update_customer_charge, delete_customer_charge
-- Revisado en producción el 30/10: la web solo las llama desde esas pantallas, el formulario viejo "Movimiento de
-- caja" de Mostrador ya no se muestra (164), y las únicas que las llaman por dentro (undo_cheque_step,
-- delete_carcass_batch) son de dueño/administrador.
--
-- Cómo: un helper require_role(roles) y una línea "perform public.require_role(...)" al principio del cuerpo de
-- cada función, inyectada sobre la definición viva (varias tienen require_plan u otros cambios que no están igual en
-- el repo). No cambia ningún dato.

create or replace function public.require_role(p_roles text[])
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and active = true and role = any (p_roles)
  ) then
    raise exception 'No tenés permiso para esta acción. Pedíselo al dueño del negocio.';
  end if;
end;
$$;
revoke all on function public.require_role(text[]) from public, anon, authenticated;

do $mig$
declare
  v_item record;
  v_proc regprocedure;
  v_def text;
  v_line text;
  v_pos int;
begin
  for v_item in
    select * from (values
      ('adjust_treasury_account', array['owner', 'admin']),
      ('transfer_treasury_funds', array['owner', 'admin']),
      ('update_product', array['owner', 'admin', 'manager', 'production']),
      ('set_product_active', array['owner', 'admin', 'manager', 'production']),
      ('delete_product', array['owner', 'admin', 'manager', 'production']),
      ('set_products_vat_rate', array['owner', 'admin', 'manager', 'production']),
      ('adjust_product_stock', array['owner', 'admin', 'manager', 'production']),
      ('void_purchase', array['owner', 'admin', 'manager']),
      ('update_purchase_item', array['owner', 'admin', 'manager']),
      ('update_customer_payment', array['owner', 'admin']),
      ('delete_customer_payment', array['owner', 'admin']),
      ('update_customer_charge', array['owner', 'admin']),
      ('delete_customer_charge', array['owner', 'admin'])
    ) as t(fn, roles)
  loop
    for v_proc in
      select p.oid::regprocedure from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = v_item.fn
    loop
      v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
      if position('public.require_role(' in v_def) > 0 then
        raise notice '178: % ya controla el rol', v_proc;
        continue;
      end if;
      -- El cuerpo empieza en la primera línea "begin" después de "AS $function$".
      v_pos := position(E'\nbegin\n' in substr(v_def, position('$function$' in v_def)));
      if v_pos = 0 then
        raise exception '178: % no tiene el "begin" esperado (revisar a mano)', v_proc;
      end if;
      v_pos := v_pos + position('$function$' in v_def) - 1;
      v_line := format(E'  perform public.require_role(%L::text[]);\n', v_item.roles::text);
      v_def := substr(v_def, 1, v_pos + 6) || v_line || substr(v_def, v_pos + 7);
      execute v_def;
    end loop;
  end loop;
end
$mig$;

insert into public.schema_migrations (version) values ('178_rpc_role_checks') on conflict do nothing;
