-- Pruebas de la migración 205 (Kommo -> embudo de interesados). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

-- Un interesado cargado a mano antes, con el celular escrito de otra forma.
insert into platform_leads (id, business_name, contact_name, phone, stage, lost_reason, attempts)
values ('00000000-0000-0000-0000-0000000c2051', 'Carnicería Vieja', 'Pedro', '011 15 5555-1234', 'perdido', 'No contestó', 4);

do $$
declare r text; v record;
begin
  -- 1) Contacto nuevo (aviso de "contacto agregado", sin mensaje): entra para hoy.
  r := public.kommo_lead_event(9001, 'Juan Pérez', '+54 9 299 444-1111', false, null);
  if r <> 'nuevo' then raise exception '1: %', r; end if;
  select * into v from platform_leads where kommo_contact_id = 9001;
  if v.stage <> 'contacto' or v.source <> 'Kommo' or v.next_contact_on <> public.today_ar()
     or v.replied_at is not null or v.phone_digits <> '2994441111' or v.business_name <> 'Juan Pérez' then
    raise exception '1 fila: %', row_to_json(v);
  end if;

  -- 2) El mismo contacto escribe: no se duplica y queda "contestó".
  r := public.kommo_lead_event(9001, 'Juan Pérez', '+5492994441111', true, 'Hola, cuánto sale?');
  if r <> 'contestó' then raise exception '2: %', r; end if;
  if (select count(*) from platform_leads where phone_digits = '2994441111') <> 1 then raise exception '2 duplicado'; end if;
  if (select replied_at from platform_leads where kommo_contact_id = 9001) is null then raise exception '2 sin replied_at'; end if;

  -- 3) El de la carga a mano escribe por Kommo: se reconoce por teléfono, revive y queda enlazado.
  r := public.kommo_lead_event(9002, 'Pedro K', '+54 9 11 5555 1234', true, 'volví');
  if r <> 'contestó' then raise exception '3: %', r; end if;
  select * into v from platform_leads where id = '00000000-0000-0000-0000-0000000c2051';
  if v.kommo_contact_id <> 9002 or v.stage <> 'contacto' or v.lost_reason is not null or v.contact_name <> 'Pedro' then
    raise exception '3 fila: %', row_to_json(v);
  end if;

  -- 4) Mensaje nuevo de alguien sin teléfono (Instagram): entra igual, con el primer mensaje en la nota.
  r := public.kommo_lead_event(9003, null, null, true, 'info?');
  if r <> 'nuevo' then raise exception '4: %', r; end if;
  select * into v from platform_leads where kommo_contact_id = 9003;
  if v.business_name <> 'Sin nombre' or v.note <> 'Primer mensaje: info?' or v.replied_at is null then
    raise exception '4 fila: %', row_to_json(v);
  end if;

  -- 5) Ya es cliente (alta): escribir no lo vuelve a poner para hoy.
  update platform_leads set stage = 'alta', next_contact_on = null where kommo_contact_id = 9001;
  r := public.kommo_lead_event(9001, 'Juan Pérez', null, true, 'consulta');
  if r <> 'ya estaba' then raise exception '5: %', r; end if;
  if (select next_contact_on from platform_leads where kommo_contact_id = 9001) is not null then raise exception '5 fecha'; end if;

  -- 6) Sin id de contacto no hace nada.
  if public.kommo_lead_event(null, 'x', '1', true, null) <> 'sin contacto' then raise exception '6'; end if;
end $$;

-- La web no puede llamarla.
set local role authenticated;
do $$
begin
  perform public.kommo_lead_event(9999, 'x', null, true, null);
  raise exception 'authenticated pudo llamar kommo_lead_event';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
