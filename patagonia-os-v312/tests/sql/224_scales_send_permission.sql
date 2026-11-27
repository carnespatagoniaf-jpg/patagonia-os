-- Pruebas de la migración 224 ("solo lectura" ya no manda productos ni cambia el formato de la balanza). Se deshace al final.
\set ON_ERROR_STOP 1
begin;

insert into companies (id, name, client_number, plan) values ('00000000-0000-0000-0000-0000000e2401', 'Carnicería A', 9941, 'estandar');
insert into branches (id, company_id, name) values ('00000000-0000-0000-0000-0000000e2402', '00000000-0000-0000-0000-0000000e2401', 'Centro');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e2405', 'duenio@a'), ('00000000-0000-0000-0000-0000000e2406', 'cajera@a'),
  ('00000000-0000-0000-0000-0000000e2407', 'produccion@a'), ('00000000-0000-0000-0000-0000000e2408', 'lectura@a');
insert into profiles (id, company_id, branch_id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000e2405', '00000000-0000-0000-0000-0000000e2401', '00000000-0000-0000-0000-0000000e2402', 'Dueño', 'owner', true),
  ('00000000-0000-0000-0000-0000000e2406', '00000000-0000-0000-0000-0000000e2401', '00000000-0000-0000-0000-0000000e2402', 'Cajera', 'cashier', true),
  ('00000000-0000-0000-0000-0000000e2407', '00000000-0000-0000-0000-0000000e2401', '00000000-0000-0000-0000-0000000e2402', 'Producción', 'production', true),
  ('00000000-0000-0000-0000-0000000e2408', '00000000-0000-0000-0000-0000000e2401', '00000000-0000-0000-0000-0000000e2402', 'Solo lectura', 'readonly', true);

create function pg_temp.must_fail(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'Tendría que haber fallado: %', p_label;
end $$;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

-- Las 4 funciones: una sola línea de rol, sin 'readonly', y el resto del cuerpo intacto.
do $$
declare r record;
begin
  for r in select p.proname, p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('save_branch_scale_config', 'delete_branch_scale_config', 'start_scale_job', 'finish_scale_job') loop
    if (length(r.prosrc) - length(replace(r.prosrc, 'public.require_role(', ''))) / length('public.require_role(') <> 1 then raise exception '% sin require_role (o repetido)', r.proname; end if;
    if position('readonly' in r.prosrc) > 0 then raise exception '% todavía deja pasar a solo lectura', r.proname; end if;
    if position('''cashier''' in r.prosrc) = 0 then raise exception '% le sacó el cajero', r.proname; end if;
  end loop;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('save_branch_scale_config', 'delete_branch_scale_config', 'start_scale_job', 'finish_scale_job')) < 4 then
    raise exception 'faltan funciones';
  end if;
  if not exists (select 1 from schema_migrations where version = '224_scales_send_permission') then raise exception 'no quedó anotada'; end if;
end $$;

set local role authenticated;

-- 1. Cajera y producción: siguen pudiendo calibrar y registrar un envío.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2406', true);
do $$
declare v_job uuid;
begin
  perform public.save_branch_scale_config('00000000-0000-0000-0000-0000000e2402', 2, 3, 7, 100, 13, 'amount');
  v_job := public.start_scale_job('00000000-0000-0000-0000-0000000e2402', 'kretz-aaaa1111', 'send', 'web', 3, null, '{}'::jsonb);
  perform public.finish_scale_job(v_job, 'done', '{}'::jsonb, '[]'::jsonb, null);
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2407', true);
do $$
begin
  perform public.start_scale_job('00000000-0000-0000-0000-0000000e2402', 'kretz-aaaa1111', 'send', 'web', 1, null, '{}'::jsonb);
  perform public.delete_branch_scale_config('00000000-0000-0000-0000-0000000e2402');
end $$;

-- 2. Solo lectura: ni formato, ni envíos (ni abrir uno, ni cerrar el de otro).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2408', true);
do $$
declare v_job uuid := (select id from scale_jobs where status = 'running' limit 1);
begin
  if v_job is null then raise exception 'falta el envío abierto de producción'; end if;
  perform pg_temp.must_fail($q$select public.save_branch_scale_config('00000000-0000-0000-0000-0000000e2402', 2, 3, 7, 100, 13, 'amount')$q$, 'solo lectura guarda formato');
  perform pg_temp.must_fail($q$select public.delete_branch_scale_config('00000000-0000-0000-0000-0000000e2402')$q$, 'solo lectura borra formato');
  perform pg_temp.must_fail($q$select public.start_scale_job('00000000-0000-0000-0000-0000000e2402', 'kretz-aaaa1111', 'send', 'web', 1, null, '{}'::jsonb)$q$, 'solo lectura abre un envío');
  perform pg_temp.must_fail(format('select public.finish_scale_job(%L::uuid, %L, %L::jsonb, %L::jsonb, null)', v_job, 'done', '{}', '[]'), 'solo lectura cierra un envío');
end $$;

reset role;
rollback;
