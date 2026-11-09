-- Leer factura con foto (Compras): la Edge Function invoice-reader le manda la
-- foto o el PDF de una factura de proveedor a Claude y devuelve los renglones
-- para completar el formulario de compra. La persona revisa y confirma con el
-- botón de siempre ("Registrar compra"): nada se guarda solo.
--
-- Acá solo se lleva la cuenta de cuántas facturas leyó cada empresa por día,
-- para poner un tope y que nadie gaste el crédito de la API. La tabla no es
-- legible desde el cliente: solo la Edge Function (service role) la toca.
create table if not exists public.invoice_reader_usage (
  company_id uuid not null references public.companies(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (company_id, day)
);

alter table public.invoice_reader_usage enable row level security;
revoke all on public.invoice_reader_usage from anon, authenticated;

-- Suma 1 a las lecturas de hoy y devuelve true, salvo que la empresa ya haya
-- llegado al tope (en ese caso no suma y devuelve false). Atómico, igual que
-- bump_help_chat_usage (migración 094).
create or replace function public.bump_invoice_reader_usage(p_company_id uuid, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.invoice_reader_usage (company_id, day, count)
  values (p_company_id, public.today_ar(), 1)
  on conflict (company_id, day)
  do update set count = public.invoice_reader_usage.count + 1
  where public.invoice_reader_usage.count < p_limit
  returning count into v_count;

  return v_count is not null;
end;
$$;

revoke all on function public.bump_invoice_reader_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.bump_invoice_reader_usage(uuid, int) to service_role;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('195_invoice_reader') on conflict do nothing;
