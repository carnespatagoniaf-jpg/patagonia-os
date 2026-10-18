-- Velocidad para crecer (pedido del dueño, 2026-10-18: "me da miedo que se me
-- trabe uno y se me traben todos").
--
-- Medido en producción antes de esta migración, con el dueño que más vende:
--   Tesorería (movimientos)      123 ms, 105 de ellos recorriendo la tabla entera
--   Cobros del día (cierre)      165 ms
--   Productos con stock          260 ms
-- con apenas 2.000 a 6.500 filas por tabla. Crece en línea recta con los datos de
-- TODOS los clientes, porque todos comparten las mismas tablas.
--
-- Dos causas:
-- 1) Las policies de RLS y las vistas comparaban company_id = current_company_id()
--    (y auth.uid()) fila por fila: Postgres vuelve a ejecutar la función en cada
--    fila. Envueltas en (select ...) se calculan UNA vez por consulta (InitPlan).
--    Mismo resultado, misma seguridad: solo cambia cuántas veces se calcula.
-- 2) Casi no había índices: 224 claves foráneas sin índice (advisor de Supabase)
--    y ninguno por company_id en las tablas grandes.
--
-- Todo es idempotente y se arma desde el catálogo de cada base (staging y prod
-- tienen diferencias), igual que la inyección de require_plan de la 101.

-- 1) Policies: current_company_id() y auth.uid() una vez por consulta --------
do $$
declare
  r record;
  v_qual text;
  v_check text;
  v_sql text;
begin
  for r in
    select schemaname, tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(current_company_id\(\)|auth\.uid\(\))'
  loop
    v_qual := r.qual;
    v_check := r.with_check;
    -- No envolver dos veces si alguna ya estaba envuelta.
    if v_qual is not null then
      v_qual := replace(replace(v_qual, 'current_company_id()', '(select public.current_company_id())'), 'auth.uid()', '(select auth.uid())');
      v_qual := replace(replace(v_qual, '(SELECT (select public.current_company_id())', '(SELECT public.current_company_id()'), '(SELECT (select auth.uid())', '(SELECT auth.uid()');
    end if;
    if v_check is not null then
      v_check := replace(replace(v_check, 'current_company_id()', '(select public.current_company_id())'), 'auth.uid()', '(select auth.uid())');
      v_check := replace(replace(v_check, '(SELECT (select public.current_company_id())', '(SELECT public.current_company_id()'), '(SELECT (select auth.uid())', '(SELECT auth.uid()');
    end if;

    v_sql := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if v_qual is not null then
      v_sql := v_sql || format(' using (%s)', v_qual);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;
    execute v_sql;
  end loop;
end;
$$;

-- 2) Vistas que filtran por empresa: la misma idea -------------------------
-- create or replace view conserva dueño y permisos; las columnas no cambian.
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and pg_get_viewdef(c.oid) like '%current_company_id()%'
      and pg_get_viewdef(c.oid) not like '%(select public.current_company_id())%'
  loop
    v_def := replace(pg_get_viewdef(r.oid), 'current_company_id()', '(select public.current_company_id())');
    v_def := replace(v_def, '(select public.(select public.current_company_id()))', '(select public.current_company_id())');
    v_def := replace(v_def, 'public.(select public.current_company_id())', '(select public.current_company_id())');
    execute format('create or replace view public.%I as %s', r.relname, v_def);
  end loop;
end;
$$;

-- 3) Índices de claves foráneas que no tienen ninguno ------------------------
-- (salvo las que apuntan a auth.users: created_by/user_id de auditoría, que no
-- se usan para buscar y solo harían más lentas las escrituras).
do $$
declare
  r record;
  v_cols text;
  v_name text;
begin
  for r in
    select con.conrelid, con.conkey, cl.relname
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_class ref on ref.oid = con.confrelid
    join pg_namespace rn on rn.oid = ref.relnamespace
    where con.contype = 'f'
      and n.nspname = 'public'
      and not (rn.nspname = 'auth' and ref.relname = 'users')
      and not exists (
        select 1 from pg_index i
        where i.indrelid = con.conrelid
          and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] = con.conkey
      )
  loop
    select string_agg(quote_ident(a.attname), ', ' order by k.ord), string_agg(a.attname, '_' order by k.ord)
    into v_cols, v_name
    from unnest(r.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = r.conrelid and a.attnum = k.attnum;

    v_name := left(r.relname || '_' || v_name, 55) || '_fk_idx';
    execute format('create index if not exists %I on public.%I (%s)', v_name, r.relname, v_cols);
  end loop;
end;
$$;

-- 4) Índices para las pantallas de todos los días ---------------------------
-- Productos con stock (Mostrador, Stock): suma de movimientos por sucursal y producto.
create index if not exists inventory_movements_company_branch_product_idx
  on public.inventory_movements (company_id, branch_id, product_id);
-- Tesorería: últimos movimientos primero.
create index if not exists treasury_movements_company_date_idx
  on public.treasury_movements (company_id, occurred_on desc, created_at desc);
-- Ventas de Mostrador por sucursal y fecha (cierre, cobros, reportes).
create index if not exists pos_sales_company_branch_created_idx
  on public.pos_sales (company_id, branch_id, created_at);
-- Auditoría: lo último primero.
create index if not exists audit_log_company_created_idx
  on public.audit_log (company_id, created_at desc);

analyze public.inventory_movements;
analyze public.treasury_movements;
analyze public.pos_sales;
analyze public.pos_sale_payments;
analyze public.pos_sale_items;
analyze public.audit_log;

insert into public.schema_migrations (version) values ('131_performance_indexes_rls') on conflict do nothing;
