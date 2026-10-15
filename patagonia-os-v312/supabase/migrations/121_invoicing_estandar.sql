-- 121: Facturas (ARCA) pasa del plan Full al Estándar (decisión del dueño, 2026-10-15).
-- Regla: lo nuevo arranca en Full y puede bajar de plan, nunca subir.
-- Solo cambia el plan mínimo: las dos funciones (se reescribe la definición que tiene cada base, como en la 101)
-- y las dos políticas restrictivas de las tablas. No toca datos.

do $$
declare
  f record;
  def text;
begin
  for f in
    select p.oid from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('save_fiscal_settings', 'request_invoice')
  loop
    def := pg_get_functiondef(f.oid);
    if position('require_plan(''full'')' in def) > 0 then
      execute replace(def, 'require_plan(''full'')', 'require_plan(''estandar'')');
    end if;
  end loop;
end $$;

drop policy if exists plan_full on public.company_fiscal_settings;
drop policy if exists plan_estandar on public.company_fiscal_settings;
create policy plan_estandar on public.company_fiscal_settings as restrictive
  for all using (public.company_plan_allows('estandar'));

drop policy if exists plan_full on public.invoices;
drop policy if exists plan_estandar on public.invoices;
create policy plan_estandar on public.invoices as restrictive
  for all using (public.company_plan_allows('estandar'));

insert into public.schema_migrations (version) values ('121_invoicing_estandar') on conflict do nothing;
