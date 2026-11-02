-- 188: nadie se saca permisos a sí mismo por error (2026-11-02).
--
-- Un administrador de un cliente se editó a sí mismo en Usuarios y se quedó sin pantallas (Usuarios, etc.):
-- update_staff_user dejaba cambiar el propio rol y el propio "Qué puede ver". Ahora, sobre uno mismo, solo se
-- puede cambiar el nombre y la sucursal; el rol y lo que se ve lo cambia otro administrador o el dueño.
-- Se inyecta sobre la definición viva (como 155). No cambia ningún dato.

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.update_staff_user(uuid,text,text,uuid,boolean,text[])');
  v_def text;
  v_anchor constant text := $a$  if p_profile_id = v_caller_id and p_active = false then
    raise exception 'No podés desactivar tu propio usuario';
  end if;
$a$;
  v_guard constant text := $b$
  if p_profile_id = v_caller_id and (
    p_role is distinct from v_target_role
    or coalesce(p_denied_permissions, '{}') is distinct from
       (select coalesce(pr.denied_permissions, '{}') from public.profiles pr where pr.id = p_profile_id)
  ) then
    raise exception 'No podés cambiar tu propio rol ni lo que ves: lo cambia otro administrador o el dueño';
  end if;
$b$;
begin
  if v_proc is null then
    raise notice '188: no está update_staff_user: se saltea';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position('No podés cambiar tu propio rol' in v_def) > 0 then
    raise notice '188: update_staff_user ya tiene la guarda';
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception '188: update_staff_user no tiene el punto esperado';
  end if;
  execute replace(v_def, v_anchor, v_anchor || v_guard);
end
$mig$;

insert into public.schema_migrations (version) values ('188_no_self_lockout') on conflict do nothing;
