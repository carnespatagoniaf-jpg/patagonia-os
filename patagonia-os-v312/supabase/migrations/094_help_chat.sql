-- Chat de ayuda con IA: solo guarda (1) cuantas preguntas hizo cada empresa por
-- dia, para poner un tope y que nadie gaste el credito de la API, y (2) las
-- preguntas que el asistente no supo responder, para ampliar la guia. Ninguna
-- tabla es legible desde el cliente: solo la Edge Function help-chat (service
-- role) las toca.
create table if not exists public.help_chat_usage (
  company_id uuid not null references public.companies(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (company_id, day)
);

create table if not exists public.help_chat_unanswered (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid,
  question text not null,
  created_at timestamptz not null default now()
);

alter table public.help_chat_usage enable row level security;
alter table public.help_chat_unanswered enable row level security;

revoke all on public.help_chat_usage from anon, authenticated;
revoke all on public.help_chat_unanswered from anon, authenticated;

-- Suma 1 a las preguntas de hoy y devuelve true, salvo que la empresa ya haya
-- llegado al tope (en ese caso no suma y devuelve false). Atomico: no hay
-- carrera entre dos preguntas simultaneas.
create or replace function public.bump_help_chat_usage(p_company_id uuid, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.help_chat_usage (company_id, day, count)
  values (p_company_id, public.today_ar(), 1)
  on conflict (company_id, day)
  do update set count = public.help_chat_usage.count + 1
  where public.help_chat_usage.count < p_limit
  returning count into v_count;

  return v_count is not null;
end;
$$;

revoke all on function public.bump_help_chat_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.bump_help_chat_usage(uuid, int) to service_role;

notify pgrst, 'reload schema';
