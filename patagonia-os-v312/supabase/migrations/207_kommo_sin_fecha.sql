-- Kommo: los contactos entran sin fecha de seguimiento (pedido del dueño, 2026-11-19:
-- "no me pongas a ninguno para escribir hoy", y para los que escriban de ahora en más
-- "sí, sin fecha").
--
-- kommo_lead_event (205) ponía next_contact_on = hoy al contacto nuevo y al que
-- volvía a escribir, así que todos aparecían en "Para escribir hoy". Ahora:
-- * contacto nuevo: sin fecha (queda en Contactos; la fecha la pone el dueño);
-- * ya cargado que escribe: se anota "contestó" (replied_at) y, si estaba perdido,
--   vuelve a "contacto"; su fecha queda como estaba.
-- Todo lo demás igual. La usan kommo-sync (206) y kommo-webhook (205).

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
      null,
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
      lost_reason = case when p_incoming and stage = 'perdido' then null else lost_reason end,
      stage = case when p_incoming and stage = 'perdido' then 'contacto' else stage end,
      updated_at = now()
  where id = v_lead.id;

  return case when p_incoming and v_lead.stage <> 'alta' then 'contestó' else 'ya estaba' end;
end;
$$;

revoke all on function public.kommo_lead_event(bigint, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.kommo_lead_event(bigint, text, text, boolean, text) to service_role;

insert into public.schema_migrations (version) values ('207_kommo_sin_fecha') on conflict do nothing;
