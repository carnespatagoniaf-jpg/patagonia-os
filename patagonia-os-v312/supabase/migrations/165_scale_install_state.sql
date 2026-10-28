-- 165: estado real de la instalación de cada balanza, en su ficha (28/10/2026, etapa 0 de la auditoría de balanzas).
--
-- Por qué: "Mis balanzas" decía "¡Listo! Tu balanza está conectada y ya podés vender" apenas se mandaban los
-- productos, sin saber si Mostrador leía bien las etiquetas, y lo que se sabía de cada balanza vivía solo en la
-- computadora donde se conectó. Ahora cada balanza tiene 5 pasos con su prueba (apps/web/src/features/scales/
-- install-status.ts): reconocida, comunicación, productos en la balanza, productos comprobados (releídos) y venta
-- probada (Mostrador leyó bien una etiqueta impresa después del último envío).
--
-- Qué cambia:
-- 1. scale_profiles.install (jsonb): las fechas y cantidades de esos pasos. Solo se guardan claves conocidas.
-- 2. set_branch_scale_install(sucursal, clave, cambios): la llama "Mis balanzas" al conectar, comparar y sincronizar.
-- 3. mark_branch_scales_sale_tested(sucursal, detalle): la llama Mostrador cuando lee bien una etiqueta de balanza.
--    No se sabe de cuál balanza salió la etiqueta: se marca en todas las activas de la sucursal. Como mucho una
--    escritura cada 10 minutos por balanza (Mostrador escanea todo el día).
--
-- Qué NO cambia: nada de la venta, los formatos de etiqueta ni los vínculos. Son datos de estado, sin plata ni stock:
-- por eso no se anotan en audit_log (serían miles de renglones por día).

alter table public.scale_profiles add column if not exists install jsonb not null default '{}'::jsonb;

create or replace function public.set_branch_scale_install(p_branch_id uuid, p_scale_key text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role text;
  v_branch uuid;
  v_clean jsonb;
  v_out jsonb;
begin
  select company_id, role, branch_id into v_company, v_role, v_branch from public.profiles where id = auth.uid() and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') and v_branch is distinct from p_branch_id then raise exception 'Sucursal inválida'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Datos inválidos'; end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_clean
  from jsonb_each(p_patch)
  where key in ('model', 'detectedAt', 'communicationAt', 'sentAt', 'sentCount', 'verifiedAt', 'verifiedCount', 'failedCount', 'lastError', 'lastErrorAt')
    and (jsonb_typeof(value) in ('string', 'number', 'null'))
    and length(value::text) <= 300;

  update public.scale_profiles
     set install = install || v_clean
   where company_id = v_company and branch_id = p_branch_id and scale_key = p_scale_key
  returning install into v_out;
  if v_out is null then raise exception 'Balanza inexistente'; end if;
  return v_out;
end;
$$;

create or replace function public.mark_branch_scales_sale_tested(p_branch_id uuid, p_detail text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role text;
  v_branch uuid;
  v_count integer;
begin
  select company_id, role, branch_id into v_company, v_role, v_branch from public.profiles where id = auth.uid() and active = true;
  if v_company is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') and v_branch is distinct from p_branch_id then raise exception 'Sucursal inválida'; end if;

  update public.scale_profiles
     set install = install || jsonb_build_object('saleTestedAt', to_jsonb(now()), 'saleTestDetail', left(coalesce(p_detail, ''), 120))
   where company_id = v_company and branch_id = p_branch_id and active
     and coalesce((install ->> 'saleTestedAt')::timestamptz, 'epoch'::timestamptz) < now() - interval '10 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.set_branch_scale_install(uuid, text, jsonb) from public, anon;
revoke all on function public.mark_branch_scales_sale_tested(uuid, text) from public, anon;
grant execute on function public.set_branch_scale_install(uuid, text, jsonb) to authenticated;
grant execute on function public.mark_branch_scales_sale_tested(uuid, text) to authenticated;

insert into public.schema_migrations (version) values ('165_scale_install_state') on conflict do nothing;
