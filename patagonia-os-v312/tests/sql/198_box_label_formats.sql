-- Pruebas de la migración 198 (formatos de etiquetas de cajas). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- Solo la empresa con la pantalla a pedido 'etiquetas_caja' (Carplat). 'Otra' no la tiene.
insert into companies (id, name, client_number, plan, features) values
  ('00000000-0000-0000-0000-0000000c9801', 'Frigorifico', 9981, 'basico', '{etiquetas_caja}'),
  ('00000000-0000-0000-0000-0000000c9811', 'Otra', 9982, 'full', '{}');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000c9802', '00000000-0000-0000-0000-0000000c9801', 'Planta'),
  ('00000000-0000-0000-0000-0000000c9812', '00000000-0000-0000-0000-0000000c9811', 'Local');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c9803', 'duenio@frigo'), ('00000000-0000-0000-0000-0000000c9804', 'cajero@frigo'),
  ('00000000-0000-0000-0000-0000000c9813', 'duenio@otra');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000c9803', '00000000-0000-0000-0000-0000000c9801', '00000000-0000-0000-0000-0000000c9802', 'Dueño', 'admin'),
  ('00000000-0000-0000-0000-0000000c9804', '00000000-0000-0000-0000-0000000c9801', '00000000-0000-0000-0000-0000000c9802', 'Cajero', 'cashier'),
  ('00000000-0000-0000-0000-0000000c9813', '00000000-0000-0000-0000-0000000c9811', '00000000-0000-0000-0000-0000000c9812', 'Dueño otra', 'owner');

set local role authenticated;

-- El administrador guarda el formato de Carplat (plan Básico alcanza), lo ve, lo edita y queda en la auditoría.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9803', true);
do $$
declare v uuid;
begin
  v := public.save_box_label_format(null, 'Carplat', 13, 0, 2, 2, '110127', 8, 4, 100);
  perform set_config('test.fmt', v::text, false);
  if (select count(*) from public.box_label_formats where id = v) <> 1 then raise exception 'no ve su formato'; end if;
  if public.save_box_label_format(v, 'Carplat cajas', 13, 0, 2, 2, '110127', 8, 4, 100) <> v then raise exception 'no editó'; end if;
  if (select name from public.box_label_formats where id = v) <> 'Carplat cajas' then raise exception 'no guardó el nombre'; end if;
  if (select count(*) from public.audit_log where entity_id = v::text and action = 'box_label_format.save') <> 2 then raise exception 'falta la auditoría'; end if;

  -- Un formato imposible (el peso se sale del código): no.
  begin
    perform public.save_box_label_format(null, 'Mal', 13, 0, 2, 2, '', 11, 4, 100);
    raise exception 'aceptó un formato imposible';
  exception when check_violation then null;
  end;
  -- Escribir la tabla directo: no.
  begin
    delete from public.box_label_formats;
    raise exception 'borró la tabla directo';
  exception when insufficient_privilege then null;
  end;
end $$;

-- El cajero lo ve (Mostrador lo usa) pero no lo cambia.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9804', true);
do $$
begin
  if (select count(*) from public.box_label_formats) <> 1 then raise exception 'el cajero no ve el formato'; end if;
  begin
    perform public.save_box_label_format(null, 'Cajero', 13, 0, 2, 2, '', 8, 4, 100);
    raise exception 'el cajero guardó un formato';
  exception when raise_exception then
    if sqlerrm = 'el cajero guardó un formato' then raise; end if;
  end;
end $$;

-- Otra empresa (sin la pantalla): no lo ve, no lo edita ni lo borra, y no puede guardar uno propio.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9813', true);
do $$
begin
  if public.box_labels_enabled() then raise exception 'otra empresa figura habilitada'; end if;
  begin
    perform public.save_box_label_format(null, 'Sin clave', 13, 0, 2, 2, '', 8, 4, 100);
    raise exception 'guardó sin la pantalla a pedido';
  exception when raise_exception then
    if sqlerrm = 'guardó sin la pantalla a pedido' then raise; end if;
  end;
  if (select count(*) from public.box_label_formats) <> 0 then raise exception 'otra empresa ve el formato'; end if;
  begin
    perform public.delete_box_label_format(current_setting('test.fmt')::uuid);
    raise exception 'otra empresa lo borró';
  exception when raise_exception then
    if sqlerrm = 'otra empresa lo borró' then raise; end if;
  end;
end $$;

-- El administrador lo borra.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9803', true);
do $$
begin
  perform public.delete_box_label_format(current_setting('test.fmt')::uuid);
  if (select count(*) from public.box_label_formats) <> 0 then raise exception 'no lo borró'; end if;
end $$;

-- Sacarle la pantalla a la empresa: deja de ver sus formatos (vuelve a verlos si se la prenden de nuevo).
reset role;
update companies set features = '{}' where id = '00000000-0000-0000-0000-0000000c9801';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9803', true);
do $$
begin
  if public.box_labels_enabled() then raise exception 'sigue habilitada sin la clave'; end if;
end $$;

-- La clave está en la lista del panel de plataforma.
reset role;
do $$
begin
  if position('etiquetas_caja' in pg_get_functiondef('public.set_company_feature(uuid,text,boolean)'::regprocedure)) = 0 then
    raise exception 'set_company_feature no acepta etiquetas_caja';
  end if;
end $$;

rollback;
