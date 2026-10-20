-- Factura ARCA: cada negocio con SU certificado (2026-10-20, pedido del dueño).
--
-- Hasta la 136 todos facturaban con el certificado de Patagonia OS y cada
-- negocio le delegaba la facturación al CUIT 27-18244890-2, que es de una
-- persona. Eso dejaba ese CUIT pegado a todos los clientes. Ahora se hace como
-- TusFacturas: la Edge Function arca-invoice genera una clave y un pedido de
-- certificado (CSR) para el CUIT del negocio, el negocio lo sube en SU ARCA
-- ("Administración de Certificados Digitales"), baja el certificado, lo sube en
-- Facturas y le da a ese certificado la relación "Facturación Electrónica".
-- Ningún CUIT de Patagonia aparece en el ARCA del cliente.
--
-- Carnes Patagonia (CUIT 27-18244890-2) sigue con el certificado compartido de
-- los secretos de la función, que es de su propio CUIT.
--
-- arca_company_certificates: la clave privada va CIFRADA (AES-GCM, con el
-- secreto ARCA_VAULT_KEY de la Edge Function); la base nunca ve la clave en claro.
-- RLS sin políticas: solo la Edge Function (service role) lee y escribe.
--
-- arca_access_tickets: el ticket del WSAA es por certificado, así que la clave
-- pasa a ser la huella SHA-256 del certificado (cert_key).

create table if not exists public.arca_company_certificates (
  company_id uuid primary key references public.companies(id) on delete cascade,
  cuit text not null,
  alias text not null,
  csr_pem text not null,
  key_cipher text not null,
  key_iv text not null,
  cert_pem text,
  cert_fingerprint text,
  cert_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.arca_company_certificates enable row level security;
revoke all on public.arca_company_certificates from anon, authenticated;

alter table public.arca_access_tickets add column if not exists cert_key text;
update public.arca_access_tickets set cert_key = 'legacy' where cert_key is null;
alter table public.arca_access_tickets alter column cert_key set not null;
alter table public.arca_access_tickets drop constraint if exists arca_access_tickets_pkey;
alter table public.arca_access_tickets add primary key (env, service, cert_key);

insert into public.schema_migrations (version) values ('137_arca_company_certificates') on conflict do nothing;
