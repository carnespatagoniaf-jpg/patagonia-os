-- 198: punto de venta y domicilio por local (191) para todos los planes. Dueño, 2026-11-14: "los clientes, si tienen
-- varias sucursales, tendrían que poder poner varios puntos de venta como permite ARCA".
-- Era de plan Empresa en dos lugares: save_branch_fiscal_settings (require_plan('empresa')) y el disparador
-- invoices_branch_fiscal (si la empresa no era Empresa, la factura salía con el punto de venta general). La tabla, la
-- función arca-invoice y las impresiones nunca miraron el plan. Se sacan las dos cosas de la definición viva
-- (inyección, como 193 y 197). Plan Básico tiene un solo local, así que en la práctica es Estándar y Full.
-- Quién puede seguir igual: dueño/administrador (lo controla save_branch_fiscal_settings).
-- Al aplicarla nadie tenía datos por local (0 filas en prod), así que ninguna factura cambia hasta que alguien cargue
-- el punto de venta de un local.

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.save_branch_fiscal_settings(uuid, integer, text)');
  v_def text;
  v_line text := E'  perform public.require_plan(''empresa'');\n';
begin
  if v_proc is null then
    raise notice '198: no está save_branch_fiscal_settings: se saltea';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  if position(v_line in v_def) = 0 then
    raise notice '198: save_branch_fiscal_settings ya no pide plan Empresa';
    return;
  end if;
  execute replace(v_def, v_line, '');
end
$mig$;

do $mig$
declare
  v_proc regprocedure := to_regprocedure('public.invoices_branch_fiscal()');
  v_def text;
  v_new text;
begin
  if v_proc is null then
    raise notice '198: no está invoices_branch_fiscal: se saltea';
    return;
  end if;
  v_def := replace(pg_get_functiondef(v_proc), E'\r\n', E'\n');
  -- El bloque "if not exists (... plan_rank(c.plan) >= plan_rank('empresa')) then return new; end if;".
  v_new := regexp_replace(v_def,
    E'\\n[ \\t]*if not exists \\(select 1 from public\\.companies c where c\\.id = new\\.company_id and public\\.plan_rank\\(c\\.plan\\) >= public\\.plan_rank\\(''empresa''\\)\\) then\\n[ \\t]*return new;\\n[ \\t]*end if;',
    '');
  if v_new = v_def then
    if position('plan_rank(''empresa'')' in v_def) > 0 then
      raise exception '198: invoices_branch_fiscal pide plan Empresa con otra forma: revisarla a mano';
    end if;
    raise notice '198: invoices_branch_fiscal ya no pide plan Empresa';
    return;
  end if;
  execute v_new;
end
$mig$;

insert into public.schema_migrations (version) values ('198_branch_fiscal_all_plans') on conflict do nothing;
