-- Pruebas de la migración 203 (remito cárnico a depósito propio sin CUIT del receptor). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values
  ('00000000-0000-0000-0000-0000000d2031', 'Frigo 203', 9931, 'full');
insert into branches (id, company_id, name) values
  ('00000000-0000-0000-0000-0000000d2032', '00000000-0000-0000-0000-0000000d2031', 'Risco'),
  ('00000000-0000-0000-0000-0000000d2033', '00000000-0000-0000-0000-0000000d2031', 'Chacabuco');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000d2035', 'duenio@frigo203');
insert into profiles (id, company_id, branch_id, full_name, role) values
  ('00000000-0000-0000-0000-0000000d2035', '00000000-0000-0000-0000-0000000d2031', '00000000-0000-0000-0000-0000000d2032', 'Dueño', 'owner');
insert into company_fiscal_settings (company_id, cuit, business_name, tax_condition, point_of_sale, address, gross_income_number, activity_start) values
  ('00000000-0000-0000-0000-0000000d2031', '30719560381', 'Frigo 203 SA', 'responsable_inscripto', 4, 'Alvarado 3427', '901-1', date '2015-03-01');
insert into rec_settings (company_id, enabled, categoria_emisor) values ('00000000-0000-0000-0000-0000000d2031', true, 3);
insert into rec_points (company_id, point_of_emission, branch_id, label) values
  ('00000000-0000-0000-0000-0000000d2031', 20, '00000000-0000-0000-0000-0000000d2032', 'Risco');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d2035', true);

create temp table t203 as select jsonb_build_object(
  'point_of_emission', 20, 'tipo_movimiento', 'ENV', 'tipo_receptor', 'EM',
  'cuit_receptor', '30719560381', 'categoria_receptor', 3, 'cod_dom_destino', 1,
  'destination_branch_id', '00000000-0000-0000-0000-0000000d2033',
  'fecha_inicio_viaje', public.today_ar()::text, 'distancia_km', 5,
  'cuit_transportista', '30719560381', 'dominio_vehiculo', 'AA000AA',
  'items', jsonb_build_array(jsonb_build_object('cod_tipo_prod', '6.24', 'kilos', 10))) as d;
grant select on t203 to authenticated;

do $$
declare v uuid; r record;
begin
  -- Depósito propio: aunque la pantalla vieja mande CUIT y categoría, no se guardan.
  v := public.create_rec_remito('00000000-0000-0000-0000-0000000d20e1', (select d from t203));
  select * into r from public.rec_remitos where id = v;
  if r.tipo_receptor <> 'EM' or r.cuit_receptor is not null or r.categoria_receptor is not null then
    raise exception 'EM guardó CUIT/categoría del receptor: %', row_to_json(r);
  end if;
  if r.destination_branch_id <> '00000000-0000-0000-0000-0000000d2033' then raise exception 'no guardó el local de destino'; end if;

  -- Sin CUIT también anda.
  perform public.create_rec_remito('00000000-0000-0000-0000-0000000d20e2', (select d - 'cuit_receptor' - 'categoria_receptor' from t203));

  -- A un cliente (MI) el CUIT sigue siendo obligatorio.
  begin
    perform public.create_rec_remito(gen_random_uuid(), (select (d || '{"tipo_receptor":"MI"}'::jsonb) - 'cuit_receptor' from t203));
    raise exception 'MI sin CUIT fue aceptado';
  exception when raise_exception then if sqlerrm not like '%CUIT del destinatario%' then raise; end if;
  end;
  v := public.create_rec_remito('00000000-0000-0000-0000-0000000d20e3', (select d || '{"tipo_receptor":"MI","cuit_receptor":"20111111112"}'::jsonb from t203));
  if (select cuit_receptor from public.rec_remitos where id = v) <> '20111111112' then raise exception 'MI perdió el CUIT'; end if;
end $$;

rollback;
