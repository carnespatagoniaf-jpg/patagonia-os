-- 179: Una venta hecha sin internet ya no se pierde si el precio cambió mientras tanto (auditoría 29/10/2026).
--
-- create_pos_sale recalcula cada renglón con el precio de AHORA y exige que los pagos sumen ese total. Si la caja
-- vendió sin conexión con el precio de antes y el dueño cambió el precio desde otra PC, al volver internet la venta
-- se rechazaba ("Los medios de pago no suman el total de la venta"): quedaba trabada en la cola y había que
-- descartarla y cargarla a mano (venta, stock y caja en riesgo). Lo mismo si el precio cambiaba entre que se abrió
-- la pantalla y se cobró.
--
-- Ahora Mostrador manda el precio que cobró en cada renglón (charged_unit_price). El servidor lo acepta SOLO si es el
-- precio actual o un precio que ese producto tuvo en las últimas 72 horas (product_price_history, que se llena sola
-- con un trigger cada vez que cambia price_retail). Cualquier otro precio se ignora y se usa el de ahora, como antes:
-- así nadie puede inventar un precio por la API. No aplica a listas de precios ni a importes de balanza (esos ya
-- traen su propio cálculo). Se inyecta sobre la definición viva de create_pos_sale (7 argumentos). No cambia datos.

create table if not exists public.product_price_history (
  id bigserial primary key,
  company_id uuid not null,
  product_id uuid not null,
  old_price numeric(14,2),
  new_price numeric(14,2),
  changed_at timestamptz not null default now()
);
create index if not exists product_price_history_product_idx on public.product_price_history (product_id, changed_at desc);
alter table public.product_price_history enable row level security;
-- Sin políticas: nadie la lee ni la escribe desde la web; la usan el trigger y la venta.
do $mig$
begin
  if exists (select 1 from pg_proc where proname = 'accountant_readonly_guard') then
    execute 'drop trigger if exists zz_accountant_readonly on public.product_price_history';
    execute 'create trigger zz_accountant_readonly before insert or update or delete on public.product_price_history for each statement execute function public.accountant_readonly_guard()';
  end if;
end
$mig$;

create or replace function public.track_product_price_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.product_price_history (company_id, product_id, old_price, new_price)
  values (new.company_id, new.id, old.price_retail, new.price_retail);
  return null;
end;
$$;
revoke all on function public.track_product_price_change() from public, anon, authenticated;

drop trigger if exists products_price_history on public.products;
create trigger products_price_history
after update of price_retail on public.products
for each row when (old.price_retail is distinct from new.price_retail)
execute function public.track_product_price_change();

-- Precio de un renglón de producto: el de la lista/actual, o el cobrado si ese producto lo tuvo en las últimas 72 h.
create or replace function public.pos_charged_unit_price(p_product public.products, p_item jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_current numeric := public.pos_list_unit_price(p_product, p_item);
  v_charged numeric;
begin
  begin
    v_charged := nullif(p_item->>'charged_unit_price', '')::numeric;
  exception when others then
    return v_current;
  end;
  if v_charged is null or v_charged < 0 or v_charged = v_current
     or nullif(p_item->>'price_list_id', '') is not null then
    return v_current;
  end if;
  if exists (
    select 1 from public.product_price_history h
    where h.product_id = p_product.id
      and h.changed_at > now() - interval '72 hours'
      and (h.old_price = v_charged or h.new_price = v_charged)
  ) then
    return v_charged;
  end if;
  return v_current;
end;
$$;
revoke all on function public.pos_charged_unit_price(public.products, jsonb) from public, anon, authenticated;

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.create_pos_sale(uuid,jsonb,jsonb,uuid,numeric,numeric,uuid)');
  v_def text;
  v_a constant text := 'public.pos_list_unit_price(v_product, v_item)';
  v_b constant text := 'public.pos_charged_unit_price(v_product, v_item)';
begin
  if v_proc is null then
    raise notice '179: no está create_pos_sale de 7 argumentos: queda como antes';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position(v_b in v_def) > 0 then
    raise notice '179: create_pos_sale ya acepta el precio cobrado';
  elsif position(v_a in v_def) = 0 then
    -- Una base sin listas de precios (167) inyectadas: no hay dónde engancharlo, queda como antes.
    raise notice '179: create_pos_sale sin pos_list_unit_price: queda como antes';
  elsif (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a) <> 2 then
    raise exception '179: create_pos_sale no tiene los dos cálculos de precio esperados (revisar a mano)';
  else
    execute replace(v_def, v_a, v_b);
  end if;
end
$mig$;

insert into public.schema_migrations (version) values ('179_offline_sale_price') on conflict do nothing;
