-- 181: "Primeros pasos" en Inicio (auditoría 29/10/2026: de 44 clientes activos, 10 no cargaron ningún producto y
-- 29 no vendieron en una semana). Dice qué pasos básicos ya hizo la empresa de quien llama, para mostrarle el
-- siguiente. Solo lee, solo su empresa. La tarjeta se oculta sola cuando están todos hechos.

create or replace function public.onboarding_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
begin
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  return jsonb_build_object(
    'products', (select count(*) from public.products where company_id = v_company_id and active),
    'stock_loaded', exists (
      select 1 from public.inventory_movements
      where company_id = v_company_id and quantity > 0 and movement_type in ('adjustment', 'purchase', 'despiece', 'transfer_in')
    ),
    'sales', (select count(*) from public.pos_sales where company_id = v_company_id),
    -- Ventas a cuenta (Clientes, Venta en ruta, frigorífico): también cuentan como "ya vende".
    'account_sales', (select count(*) from public.customer_charges where company_id = v_company_id),
    'closed_shifts', (select count(*) from public.pos_shifts where company_id = v_company_id and status = 'closed')
  );
end;
$$;
revoke all on function public.onboarding_status() from public, anon;
grant execute on function public.onboarding_status() to authenticated;

insert into public.schema_migrations (version) values ('181_onboarding_status') on conflict do nothing;
