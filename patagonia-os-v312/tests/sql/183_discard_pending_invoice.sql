-- Pruebas de la migración 183 (descartar una factura pendiente que nunca se pidió a ARCA). Se deshace al final.
\set ON_ERROR_STOP 1
begin;
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'discard_pending_invoice' and prosrc like '%pending_number is not null%') then
    raise exception 'discard_pending_invoice no controla que nunca se haya pedido a ARCA';
  end if;
  if has_function_privilege('anon', 'public.discard_pending_invoice(uuid)', 'execute') then
    raise exception 'anon puede descartar facturas';
  end if;
end $$;
rollback;
