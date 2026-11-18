-- Kommo -> embudo de interesados (pedido del dueño, 2026-11-18: "tengo un crm que
-- se llama kommo, podríamos enlazarlo con el sistema para cada vez que me hablen
-- guardar el contacto").
--
-- Kommo ya recibe el WhatsApp (y el Instagram) del dueño; un número de WhatsApp
-- Business no se puede conectar a dos sistemas, así que el sistema no lee
-- WhatsApp: Kommo le avisa por webhook a la Edge Function `kommo-webhook`, que
-- llama a kommo_lead_event() con la clave de servicio.
--
-- 1) platform_leads.kommo_contact_id: el contacto de Kommo (único), para no
--    cargarlo dos veces aunque lleguen juntos el aviso de "contacto nuevo" y el
--    de "mensaje nuevo".
-- 2) kommo_lead_event(): si el contacto ya está (por id de Kommo o por teléfono)
--    y escribió, queda "contestó" para hoy, como mark_lead_replied (salvo los que
--    ya son clientes, etapa "alta"); si no está, lo carga en "contacto" para hoy.
-- 3) kommo_webhook_events: lo que llegó y qué se hizo, para revisar si algo no
--    entra. Solo clave de servicio (RLS sin policies).

alter table public.platform_leads add column if not exists kommo_contact_id bigint;
create unique index if not exists platform_leads_kommo_contact_id_key on public.platform_leads (kommo_contact_id);

create table if not exists public.kommo_webhook_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  result text
);

alter table public.kommo_webhook_events enable row level security;
-- Sin policies a propósito.

drop trigger if exists zz_accountant_readonly on public.kommo_webhook_events;
create trigger zz_accountant_readonly before insert or update or delete on public.kommo_webhook_events
  for each statement execute function public.accountant_readonly_guard();

create or replace function public.kommo_lead_event(
  p_contact_id bigint,
  p_name text,
  p_phone text,
  p_incoming boolean,
  p_text text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(left(trim(coalesce(p_name, '')), 120), '');
  v_phone text := nullif(left(trim(coalesce(p_phone, '')), 40), '');
  v_digits text := public.lead_phone_digits(p_phone);
  v_text text := nullif(left(trim(coalesce(p_text, '')), 300), '');
  v_lead public.platform_leads%rowtype;
begin
  if p_contact_id is null then
    return 'sin contacto';
  end if;
  if v_digits is not null and length(v_digits) < 8 then
    v_digits := null;
  end if;

  select * into v_lead from public.platform_leads where kommo_contact_id = p_contact_id for update;
  if not found and v_digits is not null then
    select * into v_lead from public.platform_leads
    where phone_digits = v_digits and kommo_contact_id is null
    order by created_at
    limit 1
    for update;
  end if;

  if v_lead.id is null then
    insert into public.platform_leads (
      business_name, contact_name, phone, stage, source, note, next_contact_on, replied_at, kommo_contact_id
    )
    values (
      coalesce(v_name, 'Sin nombre'), v_name, v_phone, 'contacto', 'Kommo',
      case when v_text is not null then 'Primer mensaje: ' || v_text end,
      public.today_ar(),
      case when p_incoming then now() end,
      p_contact_id
    )
    on conflict (kommo_contact_id) do nothing;
    if found then
      return 'nuevo';
    end if;
    -- Llegó otro aviso del mismo contacto al mismo tiempo: sigue como existente.
    select * into v_lead from public.platform_leads where kommo_contact_id = p_contact_id for update;
  end if;

  update public.platform_leads
  set kommo_contact_id = p_contact_id,
      phone = coalesce(phone, v_phone),
      contact_name = coalesce(contact_name, v_name),
      replied_at = case when p_incoming and stage <> 'alta' then now() else replied_at end,
      next_contact_on = case when p_incoming and stage <> 'alta' then public.today_ar() else next_contact_on end,
      lost_reason = case when p_incoming and stage = 'perdido' then null else lost_reason end,
      stage = case when p_incoming and stage = 'perdido' then 'contacto' else stage end,
      updated_at = now()
  where id = v_lead.id;

  return case when p_incoming and v_lead.stage <> 'alta' then 'contestó' else 'ya estaba' end;
end;
$$;

revoke all on function public.kommo_lead_event(bigint, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.kommo_lead_event(bigint, text, text, boolean, text) to service_role;

insert into public.schema_migrations (version) values ('205_kommo_leads') on conflict do nothing;
