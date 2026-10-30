-- Empresa de demostración para grabar los videos de "cómo se usa".
-- Todos los datos son inventados (nombres, teléfonos, CUIT, precios).
--
-- Paso 1: desde la pantalla de administrador de plataforma, "Crear cliente":
--   Negocio:   Carnicería Demo
--   Sucursal:  Centro
--   Dueño:     el mail y la contraseña que vas a usar en los videos
-- Paso 2: correr este archivo entero en Supabase → SQL Editor (producción).
--   Busca la empresa por nombre y le carga categorías, productos con stock,
--   cuentas de tesorería, clientes, proveedores y empleados.
--   Si la empresa ya tiene productos, no hace nada (para no duplicar).
-- Las ventas, compras, turnos y pagos NO se cargan acá: se hacen en vivo en
-- los videos, así pasan por la lógica real del sistema.

do $$
declare
  v_company_name constant text := 'Carnicería Demo';
  v_company_id uuid;
  v_branch_id uuid;
  v_cat_vacuno uuid;
  v_cat_cerdo uuid;
  v_cat_pollo uuid;
  v_cat_embutidos uuid;
  v_cat_almacen uuid;
begin
  select id into v_company_id from public.companies where name = v_company_name;
  if v_company_id is null then
    raise exception 'No existe la empresa "%". Creala primero desde "Crear cliente".', v_company_name;
  end if;

  if exists (select 1 from public.products where company_id = v_company_id) then
    raise notice 'La empresa ya tiene productos: no se cargó nada.';
    return;
  end if;

  select id into v_branch_id from public.branches
  where company_id = v_company_id order by created_at limit 1;

  -- Empresa: plan completo, sin vencimiento de prueba y con las pantallas extra.
  update public.companies
  set plan = 'full',
      trial_ends_at = null,
      features = array['cuentas', 'gastos'],
      supplier_adjustments = true,
      province = 'Buenos Aires',
      city = 'Ciudad Demo'
  where id = v_company_id;

  -- Categorías
  insert into public.product_categories (company_id, name, sort_order) values (v_company_id, 'Vacuno', 1) returning id into v_cat_vacuno;
  insert into public.product_categories (company_id, name, sort_order) values (v_company_id, 'Cerdo', 2) returning id into v_cat_cerdo;
  insert into public.product_categories (company_id, name, sort_order) values (v_company_id, 'Pollo', 3) returning id into v_cat_pollo;
  insert into public.product_categories (company_id, name, sort_order) values (v_company_id, 'Embutidos', 4) returning id into v_cat_embutidos;
  insert into public.product_categories (company_id, name, sort_order) values (v_company_id, 'Almacén', 5) returning id into v_cat_almacen;

  -- Productos (código, nombre, unidad, costo, precio, stock mínimo, categoría)
  insert into public.products (company_id, code, name, unit, cost, price_retail, min_stock, category_id) values
    (v_company_id, '101', 'Asado',              'kg',   9800, 14500,  10, v_cat_vacuno),
    (v_company_id, '102', 'Vacío',              'kg',  11200, 16900,   8, v_cat_vacuno),
    (v_company_id, '103', 'Matambre',           'kg',  10500, 15800,   5, v_cat_vacuno),
    (v_company_id, '104', 'Nalga',              'kg',  11800, 17500,   8, v_cat_vacuno),
    (v_company_id, '105', 'Bola de lomo',       'kg',  10900, 16200,   6, v_cat_vacuno),
    (v_company_id, '106', 'Cuadrada',           'kg',  10900, 16200,   6, v_cat_vacuno),
    (v_company_id, '107', 'Peceto',             'kg',  12500, 18900,   4, v_cat_vacuno),
    (v_company_id, '108', 'Lomo',               'kg',  15900, 24500,   3, v_cat_vacuno),
    (v_company_id, '109', 'Bife de chorizo',    'kg',  13200, 19800,   5, v_cat_vacuno),
    (v_company_id, '110', 'Carne picada común', 'kg',   6200,  9500,  10, v_cat_vacuno),
    (v_company_id, '111', 'Carne picada especial','kg', 8400, 12900,   8, v_cat_vacuno),
    (v_company_id, '112', 'Osobuco',            'kg',   5200,  7900,   5, v_cat_vacuno),
    (v_company_id, '201', 'Bondiola',           'kg',   7800, 11900,   5, v_cat_cerdo),
    (v_company_id, '202', 'Pechito de cerdo',   'kg',   6900, 10500,   5, v_cat_cerdo),
    (v_company_id, '203', 'Matambrito de cerdo','kg',   8900, 13500,   4, v_cat_cerdo),
    (v_company_id, '301', 'Pollo entero',       'kg',   2900,  4300,  15, v_cat_pollo),
    (v_company_id, '302', 'Pechuga',            'kg',   4900,  7200,   8, v_cat_pollo),
    (v_company_id, '303', 'Pata muslo',         'kg',   3300,  4900,   8, v_cat_pollo),
    (v_company_id, '304', 'Milanesa de pollo',  'kg',   5600,  8500,   5, v_cat_pollo),
    (v_company_id, '401', 'Chorizo puro cerdo', 'kg',   6100,  9200,   6, v_cat_embutidos),
    (v_company_id, '402', 'Morcilla',           'kg',   4200,  6500,   4, v_cat_embutidos),
    (v_company_id, '403', 'Salchicha parrillera','kg',  5300,  7900,   4, v_cat_embutidos),
    (v_company_id, '501', 'Carbón 4 kg',        'unit', 3200,  5200,  10, v_cat_almacen),
    (v_company_id, '502', 'Chimichurri 250 g',  'unit', 1500,  2600,   6, v_cat_almacen),
    (v_company_id, '503', 'Huevos maple x30',   'unit', 4800,  6900,   5, v_cat_almacen);

  -- Stock inicial en la sucursal (queda como ajuste manual, igual que un conteo)
  insert into public.inventory_movements (company_id, branch_id, product_id, movement_type, quantity, reference_type, reason)
  select v_company_id, v_branch_id, p.id, 'adjustment', s.qty, 'manual_adjustment', 'Stock inicial (demo)'
  from public.products p
  join (values
    ('101', 45), ('102', 22), ('103', 12), ('104', 25), ('105', 18), ('106', 16),
    ('107', 9), ('108', 6), ('109', 14), ('110', 30), ('111', 20), ('112', 11),
    ('201', 14), ('202', 12), ('203', 7), ('301', 40), ('302', 18), ('303', 20),
    ('304', 10), ('401', 15), ('402', 8), ('403', 9), ('501', 25), ('502', 12),
    ('503', 9)
  ) as s(code, qty) on s.code = p.code
  where p.company_id = v_company_id;

  -- Cuentas de tesorería
  insert into public.treasury_accounts (company_id, branch_id, name, payment_method, initial_balance) values
    (v_company_id, v_branch_id, 'Caja Centro',     'cash',    150000),
    (v_company_id, null,        'Banco Demo',      'digital', 850000),
    (v_company_id, null,        'Billetera virtual','digital', 120000);

  -- Clientes
  insert into public.customers (company_id, branch_id, name, phone, locality, province, payment_term_days, notes) values
    (v_company_id, v_branch_id, 'Juan Pérez',              '11 5555-0101', 'Ciudad Demo', 'Buenos Aires', null, null),
    (v_company_id, v_branch_id, 'María González',          '11 5555-0102', 'Ciudad Demo', 'Buenos Aires', null, null),
    (v_company_id, v_branch_id, 'Restaurante El Fogón',    '11 5555-0103', 'Ciudad Demo', 'Buenos Aires', 15,   'Pide los martes y viernes'),
    (v_company_id, v_branch_id, 'Rotisería La Esquina',    '11 5555-0104', 'Villa Ejemplo', 'Buenos Aires', 7,  null),
    (v_company_id, v_branch_id, 'Club Social Deportivo',   '11 5555-0105', 'Villa Ejemplo', 'Buenos Aires', 30, 'Compra para eventos'),
    (v_company_id, v_branch_id, 'Carlos Rodríguez',        '11 5555-0106', 'Ciudad Demo', 'Buenos Aires', null, null);

  -- Proveedores
  insert into public.suppliers (company_id, name, category, phone, notes) values
    (v_company_id, 'Frigorífico Demo S.A.',   'carne',   '11 5555-0201', 'Media res los lunes y jueves'),
    (v_company_id, 'Granja Ejemplo',          'pollo',   '11 5555-0202', null),
    (v_company_id, 'Chacinados del Valle Demo','embutidos','11 5555-0203', null),
    (v_company_id, 'Distribuidora Ejemplo',   'almacén', '11 5555-0204', 'Carbón, condimentos y huevos');

  -- Empleados
  insert into public.employees (company_id, branch_id, full_name, base_salary) values
    (v_company_id, v_branch_id, 'Lucía Fernández (cajera)', 850000),
    (v_company_id, v_branch_id, 'Martín López (carnicero)', 980000),
    (v_company_id, v_branch_id, 'Diego Sosa (ayudante)',    720000);

  raise notice 'Listo: datos de demo cargados en "%".', v_company_name;
end $$;
