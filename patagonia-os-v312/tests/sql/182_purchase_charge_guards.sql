-- Pruebas de la migración 182 (compra anulada no editable, borrar cargo bloquea la fila). Se deshace al final.
\set ON_ERROR_STOP 1
begin;
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'update_purchase_item' and prosrc like '%Esa compra está anulada%') then
    raise exception 'update_purchase_item no controla la anulación';
  end if;
  if not exists (select 1 from pg_proc where proname = 'delete_customer_charge' and prosrc like '%and company_id = v_company_id for update;%') then
    raise exception 'delete_customer_charge no bloquea el cargo';
  end if;
end $$;
rollback;
