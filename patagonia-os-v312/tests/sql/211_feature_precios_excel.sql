-- Pruebas de la migración 211 (pantalla a pedido 'precios_excel'). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c2111', 'Cadena', 9211, 'empresa', '{}');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c2112', 'admin@patagonia'),
  ('00000000-0000-0000-0000-0000000c2113', 'cualquiera@x');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000c2112');

set local role authenticated;

-- El administrador de la plataforma la prende y la apaga; las claves de antes siguen andando.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2112', true);
do $$
begin
  if not ('precios_excel' = any(public.set_company_feature('00000000-0000-0000-0000-0000000c2111', 'precios_excel', true))) then
    raise exception 'no prendió precios_excel';
  end if;
  if not ('pedidos' = any(public.set_company_feature('00000000-0000-0000-0000-0000000c2111', 'pedidos', true))) then
    raise exception 'se perdió pedidos';
  end if;
  if position('etiquetas_caja' in pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure)) > 0
     and not ('etiquetas_caja' = any(public.set_company_feature('00000000-0000-0000-0000-0000000c2111', 'etiquetas_caja', true))) then
    raise exception 'se perdió etiquetas_caja';
  end if;
  if 'precios_excel' = any(public.set_company_feature('00000000-0000-0000-0000-0000000c2111', 'precios_excel', false)) then
    raise exception 'no apagó precios_excel';
  end if;
  begin
    perform public.set_company_feature('00000000-0000-0000-0000-0000000c2111', 'inventada', true);
    raise exception 'aceptó una clave inventada';
  exception when raise_exception then
    if sqlerrm <> 'Pantalla inválida' then raise; end if;
  end;
end $$;

-- Alguien que no es administrador de la plataforma: no.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c2113', true);
do $$
begin
  perform public.set_company_feature('00000000-0000-0000-0000-0000000c2111', 'precios_excel', true);
  raise exception 'un no-admin prendió una pantalla';
exception when raise_exception then
  if sqlerrm <> 'No autorizado' then raise; end if;
end $$;

rollback;
