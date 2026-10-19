-- Agenda de contactos (pedido del dueño, 2026-10-19: "una lista de contactos que
-- me vaya guardando por si en un mes le quiero hablar").
--
-- schedule_leads(ids, por_día): vuelve a poner en "Para escribir hoy" a los
-- interesados elegidos en la pestaña Contactos, repartidos de a p_per_day por día
-- desde hoy (para no mandar todo junto y que WhatsApp no bloquee el número). Los
-- que estaban "perdidos" vuelven a "contacto": el intento siguiente usa el mensaje
-- de "retomar" (leadAttemptMessage, intento > 4). Los dados de alta no se tocan.
-- Solo platform admins.

create or replace function public.schedule_leads(p_ids uuid[], p_per_day integer default 20)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_per_day integer := greatest(1, least(coalesce(p_per_day, 20), 200));
  v_count integer;
begin
  if not public.am_i_platform_admin() then
    raise exception 'No autorizado';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 2000 then
    raise exception 'Máximo 2000 contactos por vez';
  end if;

  with picked as (
    select l.id, row_number() over (order by l.created_at, l.id) - 1 as n
    from public.platform_leads l
    where l.id = any(p_ids) and l.stage <> 'alta'
  )
  update public.platform_leads l
  set next_contact_on = public.today_ar() + (picked.n / v_per_day)::integer,
      stage = case when l.stage = 'perdido' then 'contacto' else l.stage end,
      lost_reason = case when l.stage = 'perdido' then null else l.lost_reason end,
      -- Perdido que vuelve: le toca el mensaje de "retomar" (intento 5), no la serie de nuevo.
      attempts = case when l.stage = 'perdido' then greatest(l.attempts, 4) else l.attempts end,
      updated_at = now()
  from picked
  where picked.id = l.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.schedule_leads(uuid[], integer) from public, anon;
grant execute on function public.schedule_leads(uuid[], integer) to authenticated;

insert into public.schema_migrations (version) values ('133_schedule_leads') on conflict do nothing;
