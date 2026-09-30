-- 107 - Conciliación: el aviso de "cobros que no llegaron" se configura por
-- cuenta del banco, y hay un recordatorio de subir el resumen (2026-09-30).
--
-- El aviso solo puede comparar contra lo que se subió del banco: si nadie sube
-- el resumen, se queda callado. Por eso, además de poder prenderlo/apagarlo y
-- elegir cuántos días esperar, se avisa en Inicio cuando el último resumen
-- subido es viejo ("hace N días que no se sube el resumen").

alter table public.bank_reconciliation_accounts
  add column if not exists alerts_enabled boolean not null default true,
  add column if not exists alert_days integer not null default 3 check (alert_days between 1 and 30),
  -- 0 = no recordar.
  add column if not exists reminder_days integer not null default 7 check (reminder_days between 0 and 90);

create or replace function public.set_reconciliation_alert_settings(
  p_recon_account_id uuid,
  p_alerts_enabled boolean,
  p_alert_days integer,
  p_reminder_days integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();
  if p_alert_days is null or p_alert_days not between 1 and 30 then
    raise exception 'Los días para avisar tienen que ser entre 1 y 30';
  end if;
  if p_reminder_days is null or p_reminder_days not between 0 and 90 then
    raise exception 'Los días del recordatorio tienen que ser entre 0 y 90';
  end if;
  update public.bank_reconciliation_accounts
  set alerts_enabled = coalesce(p_alerts_enabled, true), alert_days = p_alert_days, reminder_days = p_reminder_days, updated_at = now()
  where id = p_recon_account_id and company_id = v_company_id;
  if not found then
    raise exception 'Cuenta del banco inválida';
  end if;
  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, auth.uid(), 'bank_reconciliation_account.alerts', 'bank_reconciliation_account', p_recon_account_id::text,
          jsonb_build_object('enabled', p_alerts_enabled, 'alert_days', p_alert_days, 'reminder_days', p_reminder_days));
end;
$$;

revoke all on function public.set_reconciliation_alert_settings(uuid, boolean, integer, integer) from public, anon;
grant execute on function public.set_reconciliation_alert_settings(uuid, boolean, integer, integer) to authenticated;

-- Igual que en 106, con los días y el prendido/apagado de cada cuenta.
create or replace function public.get_reconciliation_alerts(p_recon_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  return coalesce((
    select jsonb_agg(x order by x->>'date', x->>'id')
    from (
      select jsonb_build_object(
        'id', p.id,
        'recon_account_id', ra.id,
        'recon_account_name', ra.name,
        'date', (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
        'time', to_char(s.created_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI'),
        'amount', p.amount,
        'account_name', ta.name,
        'reference', p.reference,
        'cashier', coalesce(pr.full_name, 'Sin nombre'),
        'branch_name', b.name
      ) as x
      from public.bank_reconciliation_accounts ra
      join lateral (
        select min(l.line_date) as first_day, max(l.line_date) as last_day
        from public.bank_statement_lines l where l.recon_account_id = ra.id
      ) cover on cover.last_day is not null
      join public.pos_sale_payments p on p.account_id = any(ra.treasury_account_ids) and not (p.account_id = any(ra.card_account_ids))
      join public.pos_sales s on s.id = p.sale_id
      left join public.treasury_accounts ta on ta.id = p.account_id
      left join public.profiles pr on pr.id = s.created_by
      left join public.branches b on b.id = s.branch_id
      where ra.company_id = v_company_id
        and ra.alerts_enabled
        and (p_recon_account_id is null or ra.id = p_recon_account_id)
        and s.company_id = v_company_id and s.voided_at is null
        and p.amount > 0
        and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date between cover.first_day and cover.last_day - ra.alert_days
        and not exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id)
        and not exists (
          select 1 from public.bank_statement_lines l
          where l.recon_account_id = ra.id and l.amount > 0 and l.status <> 'ignored'
            and abs(l.amount - p.amount) <= greatest(500, p.amount * 0.02)
            and l.line_date between (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date - 3
                                and (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date + 7
        )
      limit 500
    ) q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_reconciliation_alerts(uuid) from public, anon;
grant execute on function public.get_reconciliation_alerts(uuid) to authenticated;

-- Recordatorios: cuentas del banco cuyo último resumen llega hasta hace más de
-- reminder_days días (o que nunca subieron uno).
create or replace function public.get_reconciliation_reminders()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'recon_account_id', ra.id,
      'name', ra.name,
      'last_line_date', cover.last_day,
      'last_import_at', cover.last_import,
      'reminder_days', ra.reminder_days,
      'days_behind', public.today_ar() - coalesce(cover.last_day, (ra.created_at at time zone 'America/Argentina/Buenos_Aires')::date)
    ) order by ra.name)
    from public.bank_reconciliation_accounts ra
    left join lateral (
      select max(l.line_date) as last_day,
             (select max(i.created_at) from public.bank_statement_imports i where i.recon_account_id = ra.id) as last_import
      from public.bank_statement_lines l where l.recon_account_id = ra.id
    ) cover on true
    where ra.company_id = v_company_id
      and ra.reminder_days > 0
      and public.today_ar() - coalesce(cover.last_day, (ra.created_at at time zone 'America/Argentina/Buenos_Aires')::date) > ra.reminder_days
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_reconciliation_reminders() from public, anon;
grant execute on function public.get_reconciliation_reminders() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('107_reconciliation_alert_settings') on conflict do nothing;
