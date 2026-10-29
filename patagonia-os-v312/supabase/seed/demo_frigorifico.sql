-- Empresa de demostración del Frigorífico (para mostrarle a un cliente).
-- Todos los datos son inventados.
--
-- Antes: la migración 169_frigorifico.sql tiene que estar corrida.
-- Paso 1: desde "Crear cliente" (administrador de plataforma):
--   Negocio:  Frigorífico Demo
--   Sucursal: Planta
--   Dueño:    el mail y la contraseña de la demo
-- Paso 2: correr este archivo entero en Supabase → SQL Editor.
--   Prende la pantalla Frigorífico, crea la carnicería propia "Carnicería Centro"
--   (ciclo 2) con el producto "Media res", 4 cámaras, 3 clientes con cuenta
--   corriente, 2 tropas ya faenadas en cámara y 1 DT de 10 novillos para faenar
--   en vivo. Si la empresa ya tiene cámaras, no hace nada.

do $$
declare
  v_company_name constant text := 'Frigorífico Demo';
  v_company_id uuid;
  v_planta uuid;
  v_carniceria uuid;
  v_cam uuid[] := array[]::uuid[];
  v_dt uuid;
  v_ayer date := current_date - 1;
  v_garron integer := 1;
  v_base numeric;
  i integer;
  a integer;
  s integer;
begin
  select id into v_company_id from public.companies where name = v_company_name;
  if v_company_id is null then
    raise exception 'No existe la empresa "%". Creala primero desde "Crear cliente".', v_company_name;
  end if;
  if exists (select 1 from public.frigo_camaras where company_id = v_company_id) then
    raise notice 'La empresa ya tiene cámaras: no se cargó nada.';
    return;
  end if;

  update public.companies
  set features = (select array(select distinct unnest(features || array['frigorifico']))),
      plan = 'full', trial_ends_at = null,
      authorized_branches = greatest(authorized_branches, 2)
  where id = v_company_id;

  select id into v_planta from public.branches where company_id = v_company_id order by created_at limit 1;
  insert into public.branches (company_id, name) values (v_company_id, 'Carnicería Centro') returning id into v_carniceria;

  insert into public.products (company_id, code, name, unit, cost, price_retail, min_stock)
  values (v_company_id, '900', 'Media res', 'kg', 6200, 6900, 0);

  for i in 1..4 loop
    insert into public.frigo_camaras (company_id, number, name, capacity)
    values (v_company_id, i, 'Cámara ' || i, case when i <= 2 then 80 else 60 end);
  end loop;
  select array_agg(id order by number) into v_cam from public.frigo_camaras where company_id = v_company_id;

  insert into public.customers (company_id, branch_id, name, phone, locality, province, payment_term_days) values
    (v_company_id, v_planta, 'Carnicería El Tropero',   '11 5555-0301', 'Ciudad Demo', 'Buenos Aires', 15),
    (v_company_id, v_planta, 'Supermercado Ejemplo',    '11 5555-0302', 'Ciudad Demo', 'Buenos Aires', 30),
    (v_company_id, v_planta, 'Distribuidora Sur Demo',  '11 5555-0303', 'Villa Ejemplo', 'Buenos Aires', 7);

  -- Tropa 101: 10 novillos (20 medias) en Cámara 1 y 2. Tropa 102: 8 vaquillonas (16 medias) en Cámara 3.
  insert into public.frigo_dts (company_id, branch_id, dt_number, dt_date, producer, renspa, origin, category, heads, tropa, slaughter_date, status)
  values (v_company_id, v_planta, 'DT-e 4471203', v_ayer - 1, 'Estancia La Demo', '01.234.0.00001/00', 'Ciudad Demo, Bs. As.', 'Novillo', 10, 101, v_ayer, 'faenado')
  returning id into v_dt;
  for a in 1..10 loop
    v_base := 104 + ((a * 37) % 22);
    for s in 1..2 loop
      insert into public.frigo_medias (company_id, branch_id, dt_id, tropa, garron, slaughter_date, animal, side, kg, camara_id)
      values (v_company_id, v_planta, v_dt, 101, v_garron, v_ayer, a, s, v_base + s * 0.7, case when a <= 6 then v_cam[1] else v_cam[2] end);
      v_garron := v_garron + 1;
    end loop;
  end loop;

  insert into public.frigo_dts (company_id, branch_id, dt_number, dt_date, producer, renspa, origin, category, heads, tropa, slaughter_date, status)
  values (v_company_id, v_planta, 'DT-e 4471388', v_ayer - 1, 'Ganadera Ejemplo S.A.', '01.234.0.00002/00', 'Villa Ejemplo, Bs. As.', 'Vaquillona', 8, 102, v_ayer, 'faenado')
  returning id into v_dt;
  for a in 1..8 loop
    v_base := 84 + ((a * 29) % 15);
    for s in 1..2 loop
      insert into public.frigo_medias (company_id, branch_id, dt_id, tropa, garron, slaughter_date, animal, side, kg, camara_id)
      values (v_company_id, v_planta, v_dt, 102, v_garron, v_ayer, a, s, v_base + s * 0.4, v_cam[3]);
      v_garron := v_garron + 1;
    end loop;
  end loop;

  -- Para faenar en vivo en la demo.
  insert into public.frigo_dts (company_id, branch_id, dt_number, dt_date, producer, renspa, origin, category, heads)
  values (v_company_id, v_planta, 'DT-e 4472015', current_date, 'Campo El Ombú Demo', '01.234.0.00003/00', 'Pueblo Demo, Bs. As.', 'Novillo', 10);

  raise notice 'Listo: datos de demo cargados en "%".', v_company_name;
end $$;
