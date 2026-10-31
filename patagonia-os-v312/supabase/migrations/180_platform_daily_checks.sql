-- 180: "Para revisar hoy" en el panel de Patagonia (auditoría 29/10/2026: revisión diaria de datos raros).
--
-- La auditoría encontró, mirando a mano, 15 cajas de clientes activos abiertas hace días, 478 productos con stock
-- negativo, clientes que no venden hace una semana y facturas que pueden quedar pendientes. Esta función lo junta
-- por cliente activo para verlo cada mañana en el panel (solo administradores de la plataforma). Solo lee.

create or replace function public.platform_daily_checks()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'Solo los administradores de Patagonia';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.problems desc, x.name)
    from (
      select
        c.id,
        c.name,
        c.plan,
        (c.trial_ends_at is not null and c.trial_ends_at > now()) as in_trial,
        (select count(*) from public.products p where p.company_id = c.id) as products,
        (select max(s.created_at) from public.pos_sales s where s.company_id = c.id) as last_sale_at,
        (select count(*) from public.pos_shifts sh where sh.company_id = c.id and sh.status = 'open' and sh.opened_at < now() - interval '20 hours') as open_shifts_old,
        (select min(sh.opened_at) from public.pos_shifts sh where sh.company_id = c.id and sh.status = 'open' and sh.opened_at < now() - interval '20 hours') as oldest_open_shift,
        (select count(*) from (
           select m.product_id, m.branch_id from public.inventory_movements m
           join public.products p on p.id = m.product_id and p.active
           where m.company_id = c.id
           group by m.product_id, m.branch_id having sum(m.quantity) < -0.001) n) as negative_stock,
        (select count(*) from public.products p where p.company_id = c.id and p.active and p.cost > 0 and p.price_retail > 0 and p.price_retail < p.cost) as below_cost,
        (select count(*) from public.invoices i where i.company_id = c.id and i.status = 'pendiente' and i.created_at < now() - interval '1 hour') as stuck_invoices,
        (
          (case when (select count(*) from public.pos_shifts sh where sh.company_id = c.id and sh.status = 'open' and sh.opened_at < now() - interval '20 hours') > 0 then 1 else 0 end)
          + (case when (select count(*) from public.invoices i where i.company_id = c.id and i.status = 'pendiente' and i.created_at < now() - interval '1 hour') > 0 then 1 else 0 end)
          + (case when (select count(*) from public.products p where p.company_id = c.id and p.active and p.cost > 0 and p.price_retail > 0 and p.price_retail < p.cost) > 0 then 1 else 0 end)
          + (case when coalesce((select max(s.created_at) from public.pos_sales s where s.company_id = c.id), 'epoch') < now() - interval '7 days' then 1 else 0 end)
        ) as problems
      from public.companies c
      where c.active
    ) x
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.platform_daily_checks() from public, anon;
grant execute on function public.platform_daily_checks() to authenticated;

insert into public.schema_migrations (version) values ('180_platform_daily_checks') on conflict do nothing;
