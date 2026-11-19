-- Pruebas de la migración 207 (Kommo entra sin fecha). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into platform_leads (id, business_name, phone, stage, next_contact_on)
values ('00000000-0000-0000-0000-0000000c2071', 'Con fecha', '2994007777', 'contacto', date '2030-01-15');

do $$
declare r text; v record;
begin
  -- Contacto nuevo (con o sin mensaje): sin fecha.
  r := public.kommo_lead_event(7071, 'Nuevo', '+54 9 299 400-1234', false, null);
  if r <> 'nuevo' then raise exception '1: %', r; end if;
  if (select next_contact_on from platform_leads where kommo_contact_id = 7071) is not null then raise exception '1 tiene fecha'; end if;
  r := public.kommo_lead_event(7072, 'Escribió', null, true, 'hola');
  if r <> 'nuevo' then raise exception '2: %', r; end if;
  select * into v from platform_leads where kommo_contact_id = 7072;
  if v.next_contact_on is not null or v.replied_at is null then raise exception '2 fila: %', row_to_json(v); end if;

  -- Ya cargado que escribe: contestó, y la fecha que tenía no cambia.
  r := public.kommo_lead_event(7073, 'X', '+5492994007777', true, 'volví');
  if r <> 'contestó' then raise exception '3: %', r; end if;
  select * into v from platform_leads where id = '00000000-0000-0000-0000-0000000c2071';
  if v.kommo_contact_id <> 7073 or v.replied_at is null or v.next_contact_on <> date '2030-01-15' then
    raise exception '3 fila: %', row_to_json(v);
  end if;

  -- El nuevo sin fecha que vuelve a escribir sigue sin fecha.
  r := public.kommo_lead_event(7071, 'Nuevo', null, true, 'otra vez');
  if r <> 'contestó' then raise exception '4: %', r; end if;
  if (select next_contact_on from platform_leads where kommo_contact_id = 7071) is not null then raise exception '4 tiene fecha'; end if;
end $$;

rollback;
