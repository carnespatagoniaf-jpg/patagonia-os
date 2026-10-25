-- 159: Gasto de publicidad de Meta en Finanzas (panel de administración, 25/10/2026).
--
-- Cada día se trae de la API de Marketing de Meta (solo lectura, permiso ads_read) lo que gastó cada campaña y se
-- anota como gasto de "Publicidad" en la cuenta elegida, uno por campaña y por día (meta_key = campaña|día): si
-- Meta corrige el gasto de un día, se actualiza ese mismo movimiento, nunca se duplica.
--   * La clave de acceso se guarda acá y solo la lee la Edge Function meta-ads-sync (service role). Ninguna
--     función la devuelve; la tabla tiene RLS y no tiene políticas.
--   * Meta informa el gasto SIN impuestos: el IVA y las percepciones de la tarjeta se cargan aparte.

create table if not exists public.platform_meta_settings (
  id boolean primary key default true check (id),
  ad_account_id text not null,
  access_token text not null,
  account_id uuid not null references public.platform_fin_accounts(id),
  from_investment boolean not null default false,
  last_sync_at timestamptz,
  last_sync_until date,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.platform_meta_settings enable row level security;

alter table public.platform_fin_movements add column if not exists meta_key text unique;

do $$
begin
  execute 'drop trigger if exists zz_accountant_readonly on public.platform_meta_settings';
  execute 'create trigger zz_accountant_readonly before insert or update or delete on public.platform_meta_settings for each statement execute function public.accountant_readonly_guard()';
end $$;

-- Estado de la conexión (sin la clave).
create or replace function public.fin_meta_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v public.platform_meta_settings%rowtype;
begin
  perform public.platform_fin_guard();
  select * into v from public.platform_meta_settings where id;
  if v.id is null then return jsonb_build_object('connected', false); end if;
  return jsonb_build_object('connected', true, 'adAccountId', v.ad_account_id, 'accountId', v.account_id, 'fromInvestment', v.from_investment,
    'lastSyncAt', v.last_sync_at, 'lastSyncUntil', v.last_sync_until, 'lastError', v.last_error,
    'tokenEnd', right(v.access_token, 4));
end;
$$;

-- Guardar o cambiar la conexión. p_token null = dejar la clave que ya estaba.
create or replace function public.fin_meta_save(p_ad_account_id text, p_token text, p_account_id uuid, p_from_investment boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ad text := regexp_replace(coalesce(p_ad_account_id, ''), '[^0-9]', '', 'g');
begin
  perform public.platform_fin_guard();
  if v_ad = '' then raise exception 'Falta el número de cuenta publicitaria'; end if;
  if not exists (select 1 from public.platform_fin_accounts where id = p_account_id) then raise exception 'Elegí la cuenta de Finanzas'; end if;
  if exists (select 1 from public.platform_meta_settings where id) then
    update public.platform_meta_settings set ad_account_id = v_ad, account_id = p_account_id, from_investment = coalesce(p_from_investment, false),
      access_token = coalesce(nullif(trim(p_token), ''), access_token), last_error = null, updated_at = now() where id;
  else
    if nullif(trim(coalesce(p_token, '')), '') is null then raise exception 'Pegá la clave de acceso de Meta'; end if;
    insert into public.platform_meta_settings (ad_account_id, access_token, account_id, from_investment) values (v_ad, trim(p_token), p_account_id, coalesce(p_from_investment, false));
  end if;
end;
$$;

create or replace function public.fin_meta_disconnect()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.platform_fin_guard();
  delete from public.platform_meta_settings where id; -- los gastos ya anotados quedan
end;
$$;

revoke all on function public.fin_meta_status() from public, anon;
grant execute on function public.fin_meta_status() to authenticated;
revoke all on function public.fin_meta_save(text, text, uuid, boolean) from public, anon;
grant execute on function public.fin_meta_save(text, text, uuid, boolean) to authenticated;
revoke all on function public.fin_meta_disconnect() from public, anon;
grant execute on function public.fin_meta_disconnect() to authenticated;

insert into public.schema_migrations (version) values ('159_platform_meta_ads') on conflict do nothing;
