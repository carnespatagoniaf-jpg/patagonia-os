-- 186: "Hoy en tus locales" para el dueño en el celular (auditoría 29/10/2026, días 61-90). Solo lectura.
--
-- Arriba de Inicio, dueño o administrador ven cada sucursal de un vistazo: lo vendido hoy en Mostrador, si la caja
-- está abierta (desde qué hora y quién atiende), cómo dieron los cierres de hoy (el faltante/sobrante que el cierre
-- anotó en Tesorería desde la 164) y las ventas anuladas hoy. Antes había que entrar a Sucursales, Mostrador y Control
-- de caja, sucursal por sucursal. No cambia nada.

create or replace function public.owner_today()
returns table (
  branch_id uuid,
  branch_name text,
  is_vehicle boolean,
  sales_total numeric,
  sales_count integer,
  last_sale_at timestamptz,
  voided_count integer,
  voided_total numeric,
  open_since timestamptz,
  open_cashier text,
  closes_today integer,
  close_difference numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
  v_from timestamptz := (public.today_ar()::timestamp at time zone 'America/Argentina/Buenos_Aires');
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador';
  end if;

  return query
  select
    b.id,
    b.name,
    coalesce(b.is_vehicle, false),
    coalesce(sales.total, 0),
    coalesce(sales.n, 0)::integer,
    sales.last_at,
    coalesce(voided.n, 0)::integer,
    coalesce(voided.total, 0),
    open_shift.opened_at,
    open_shift.cashier,
    coalesce(closes.n, 0)::integer,
    closes.difference
  from public.branches b
  left join lateral (
    select sum(s.total) as total, count(*) as n, max(s.created_at) as last_at
    from public.pos_sales s
    where s.company_id = v_company_id and s.branch_id = b.id and s.created_at >= v_from and s.voided_at is null
  ) sales on true
  left join lateral (
    select sum(s.total) as total, count(*) as n
    from public.pos_sales s
    where s.company_id = v_company_id and s.branch_id = b.id and s.voided_at >= v_from
  ) voided on true
  left join lateral (
    select sh.opened_at, coalesce(e.full_name, nullif(sh.cashier_name, ''), p.full_name) as cashier
    from public.pos_shifts sh
    left join public.employees e on e.id = sh.cashier_employee_id
    left join public.profiles p on p.id = sh.opened_by
    where sh.company_id = v_company_id and sh.branch_id = b.id and sh.status = 'open'
    order by sh.opened_at desc
    limit 1
  ) open_shift on true
  left join lateral (
    select
      count(*) as n,
      sum((
        select coalesce(sum(case when t.direction = 'in' then t.amount else -t.amount end), 0)
        from public.treasury_movements t
        where t.company_id = v_company_id and t.reference_type = 'pos_shift_close' and t.reference_id = sh.id
      )) as difference
    from public.pos_shifts sh
    where sh.company_id = v_company_id and sh.branch_id = b.id and sh.status = 'closed' and sh.closed_at >= v_from
  ) closes on true
  where b.company_id = v_company_id and b.active = true
  order by coalesce(b.is_vehicle, false), b.name;
end;
$$;
revoke all on function public.owner_today() from public, anon;
grant execute on function public.owner_today() to authenticated;

insert into public.schema_migrations (version) values ('186_owner_today') on conflict do nothing;
