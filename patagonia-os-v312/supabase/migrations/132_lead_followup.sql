-- Seguimiento de interesados (pedido del dueño, 2026-10-18: "tengo más de 100
-- contactos que preguntan por WhatsApp pero nunca contestan de vuelta"; llegan
-- por la publicidad de Instagram, escriben y no dicen más nada).
--
-- Sobre platform_leads (116):
-- 1) attempts / last_contacted_at / replied_at / phone_digits: cuántas veces se
--    le escribió, cuándo, si contestó, y el teléfono solo con números para no
--    cargar dos veces al mismo.
-- 2) import_platform_leads(jsonb): carga muchos de una vez (pegados de WhatsApp
--    o un archivo de contactos), salta los repetidos y reparte la primera fecha
--    de contacto de a p_per_day por día, para no mandar 100 mensajes iguales el
--    mismo día (WhatsApp puede bloquear el número).
-- 3) mark_lead_contacted: suma un intento y agenda el próximo (3, 7 y 14 días).
--    Después del 4.º sin respuesta pasa a "perdido" con motivo "No contestó";
--    se puede revivir editándolo.
-- 4) mark_lead_replied: contestó; queda para hoy así se sigue la charla.
-- Solo platform admins, como el resto del embudo.

alter table public.platform_leads add column if not exists attempts integer not null default 0;
alter table public.platform_leads add column if not exists last_contacted_at timestamptz;
alter table public.platform_leads add column if not exists replied_at timestamptz;
alter table public.platform_leads add column if not exists phone_digits text;

create index if not exists platform_leads_phone_digits_idx on public.platform_leads (phone_digits);

-- Los últimos 10 dígitos identifican el celular argentino con o sin 54 / 9 / 0 / 15 adelante.
create or replace function public.lead_phone_digits(p_phone text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if d like '00%' then d := substr(d, 3); end if;
  if d like '54%' and length(d) >= 12 then d := substr(d, 3); end if;
  if d like '9%' and length(d) = 11 then d := substr(d, 2); end if;
  if d like '0%' then d := substr(d, 2); end if;
  -- Característica + 15 + número (11 15 5555 5555) -> sin el 15.
  if length(d) = 12 then d := regexp_replace(d, '^(\d{2,4})15(\d{6,8})$', '\1\2'); end if;
  return nullif(right(d, 10), '');
end;
$$;

revoke all on function public.lead_phone_digits(text) from public, anon, authenticated;

create or replace function public.platform_leads_set_phone_digits()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.phone_digits := public.lead_phone_digits(new.phone);
  return new;
end;
$$;

revoke all on function public.platform_leads_set_phone_digits() from public, anon, authenticated;

update public.platform_leads set phone_digits = public.lead_phone_digits(phone) where phone is not null;

drop trigger if exists platform_leads_set_phone_digits on public.platform_leads;
create trigger platform_leads_set_phone_digits
before insert or update of phone on public.platform_leads
for each row execute function public.platform_leads_set_phone_digits();

-- Lista: + los campos nuevos (cambia el tipo de retorno: drop + create).
drop function if exists public.list_platform_leads();

create function public.list_platform_leads()
returns table (
  id uuid,
  business_name text,
  contact_name text,
  phone text,
  province text,
  city text,
  stage text,
  source text,
  note text,
  next_contact_on date,
  lost_reason text,
  company_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  attempts integer,
  last_contacted_at timestamptz,
  replied_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.business_name, l.contact_name, l.phone, l.province, l.city, l.stage, l.source, l.note,
         l.next_contact_on, l.lost_reason, l.company_id, l.created_at, l.updated_at,
         l.attempts, l.last_contacted_at, l.replied_at
  from public.platform_leads l
  where public.am_i_platform_admin()
  order by l.created_at desc
$$;

revoke all on function public.list_platform_leads() from public, anon;
grant execute on function public.list_platform_leads() to authenticated;

-- Carga masiva. p_rows = [{"name", "phone", y opcionales: "attempts" (mensajes que
-- ya se le mandaron), "replied" (true = ya contestó), "lost_reason" (dijo que no),
-- "note"}]. Devuelve {inserted, skipped}. Los que ya contestaron quedan para hoy;
-- los perdidos, sin fecha; el resto se reparte de a p_per_day por día.
create or replace function public.import_platform_leads(p_rows jsonb, p_source text, p_per_day integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_name text;
  v_phone text;
  v_digits text;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_spread integer := 0;
  v_attempts integer;
  v_replied boolean;
  v_lost text;
  v_per_day integer := greatest(1, least(coalesce(p_per_day, 20), 200));
  v_today date := public.today_ar();
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Lista inválida';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Máximo 2000 contactos por vez';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_name := nullif(trim(coalesce(v_row->>'name', '')), '');
    v_phone := nullif(trim(coalesce(v_row->>'phone', '')), '');
    v_digits := public.lead_phone_digits(v_phone);
    if v_digits is null or length(v_digits) < 8 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if exists (select 1 from public.platform_leads where phone_digits = v_digits) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_attempts := greatest(0, least(coalesce((v_row->>'attempts')::integer, 0), 4));
    v_replied := coalesce((v_row->>'replied')::boolean, false);
    v_lost := nullif(trim(coalesce(v_row->>'lost_reason', '')), '');

    insert into public.platform_leads (
      business_name, contact_name, phone, stage, source, note, next_contact_on, lost_reason,
      attempts, last_contacted_at, replied_at, created_by
    )
    values (
      coalesce(v_name, 'Sin nombre'),
      v_name,
      v_phone,
      case when v_lost is not null then 'perdido' else 'contacto' end,
      nullif(trim(coalesce(p_source, '')), ''),
      nullif(trim(coalesce(v_row->>'note', '')), ''),
      case
        when v_lost is not null then null
        when v_replied then v_today
        else v_today + (v_spread / v_per_day)
      end,
      v_lost,
      v_attempts,
      case when v_attempts > 0 then now() end,
      case when v_replied then now() end,
      auth.uid()
    );
    if v_lost is null and not v_replied then
      v_spread := v_spread + 1;
    end if;
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped);
end;
$$;

revoke all on function public.import_platform_leads(jsonb, text, integer) from public, anon;
grant execute on function public.import_platform_leads(jsonb, text, integer) to authenticated;

-- Le escribí: un intento más y el próximo a los 3, 7 y 14 días; al 4.º, perdido.
create or replace function public.mark_lead_contacted(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_today date := public.today_ar();
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;

  update public.platform_leads
  set attempts = attempts + 1, last_contacted_at = now(), updated_at = now()
  where id = p_id
  returning attempts into v_attempts;
  if not found then
    raise exception 'Interesado inválido';
  end if;

  if v_attempts >= 4 then
    update public.platform_leads
    set stage = 'perdido', lost_reason = coalesce(lost_reason, 'No contestó (4 mensajes)'), next_contact_on = null
    where id = p_id and stage = 'contacto' and replied_at is null;
    if found then
      return 'perdido';
    end if;
  end if;

  update public.platform_leads
  set next_contact_on = v_today + (case v_attempts when 1 then 3 when 2 then 7 else 14 end)
  where id = p_id;
  return 'agendado';
end;
$$;

revoke all on function public.mark_lead_contacted(uuid) from public, anon;
grant execute on function public.mark_lead_contacted(uuid) to authenticated;

create or replace function public.mark_lead_replied(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  update public.platform_leads
  set replied_at = now(), next_contact_on = public.today_ar(), updated_at = now(),
      stage = case when stage = 'perdido' then 'contacto' else stage end,
      lost_reason = case when stage = 'perdido' then null else lost_reason end
  where id = p_id;
  if not found then
    raise exception 'Interesado inválido';
  end if;
end;
$$;

revoke all on function public.mark_lead_replied(uuid) from public, anon;
grant execute on function public.mark_lead_replied(uuid) to authenticated;

insert into public.schema_migrations (version) values ('132_lead_followup') on conflict do nothing;
