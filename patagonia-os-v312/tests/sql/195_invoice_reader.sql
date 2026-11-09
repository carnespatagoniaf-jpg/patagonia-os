-- Pruebas de la migración 195 (tope diario de "Leer factura con foto"). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number) values ('00000000-0000-0000-0000-0000000195c1', 'Facturas', 9951);

do $$
declare ok boolean;
begin
  -- Tope 2: las dos primeras pasan, la tercera no, y no suma de más.
  if not public.bump_invoice_reader_usage('00000000-0000-0000-0000-0000000195c1', 2) then raise exception 'la primera lectura no pasó'; end if;
  if not public.bump_invoice_reader_usage('00000000-0000-0000-0000-0000000195c1', 2) then raise exception 'la segunda lectura no pasó'; end if;
  ok := public.bump_invoice_reader_usage('00000000-0000-0000-0000-0000000195c1', 2);
  if ok then raise exception 'pasó una lectura por encima del tope'; end if;
  if (select count from invoice_reader_usage where company_id = '00000000-0000-0000-0000-0000000195c1') <> 2 then
    raise exception 'el contador quedó mal';
  end if;
end
$$;

-- Un usuario logueado no puede llamar la función ni leer la tabla.
set local role authenticated;
do $$
begin
  begin
    perform public.bump_invoice_reader_usage('00000000-0000-0000-0000-0000000195c1', 100);
    raise exception 'authenticated pudo sumar lecturas';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.invoice_reader_usage;
    raise exception 'authenticated pudo leer la tabla';
  exception when insufficient_privilege then null;
  end;
end
$$;

rollback;
