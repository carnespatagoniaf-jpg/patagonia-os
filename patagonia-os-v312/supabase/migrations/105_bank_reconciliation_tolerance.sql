-- 105 - Conciliación: coincidencias "casi iguales" (como las grandes empresas:
-- reglas de cruce con tolerancia y la diferencia contabilizada aparte).
--
-- Con el resumen real (Banco Provincia, 17 a 30/9/2026) aparecieron 65
-- transferencias que son el mismo cobro que Mostrador pero con unos pesos de
-- diferencia (la cajera cargó el importe redondeado): típicamente de $1 a $400.
-- Antes solo se podía confirmar si cerraba exacto. Ahora confirm_bank_match
-- acepta p_adjustment: la diferencia (banco − sistema) se registra como un
-- movimiento de Tesorería "ajuste" en la cuenta principal ("Diferencia de
-- cobro (conciliación)"), para que quede a la vista y no se pierda. La
-- comisión (p_fee) sigue igual. Tope: el ajuste no puede pasar de $500 o 2% de
-- lo elegido, lo que sea mayor (lo mismo que sugiere la pantalla).
--
-- Cambia la firma de confirm_bank_match (se agrega un parámetro): se borra la
-- versión anterior y confirm_bank_matches pasa a usar la nueva.

drop function if exists public.confirm_bank_match(uuid, uuid[], uuid[], numeric);

create or replace function public.confirm_bank_match(
  p_line_id uuid,
  p_movement_ids uuid[],
  p_payment_ids uuid[],
  p_fee numeric,
  -- Con valor por defecto: la página anterior (sin este parámetro) sigue andando.
  p_adjustment numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_line public.bank_statement_lines%rowtype;
  v_acc public.bank_reconciliation_accounts%rowtype;
  v_movement_ids uuid[] := coalesce(p_movement_ids, '{}');
  v_payment_ids uuid[] := coalesce(p_payment_ids, '{}');
  v_count integer;
  v_total numeric(14,2) := 0;
  v_part numeric(14,2);
  v_branch_id uuid;
  v_fee numeric(14,2) := round(coalesce(p_fee, 0), 2);
  v_adjustment numeric(14,2) := round(coalesce(p_adjustment, 0), 2);
  v_created_movement_id uuid;
begin
  perform public.require_plan('full');
  v_company_id := public.reconciliation_caller_company();

  select * into v_line from public.bank_statement_lines where id = p_line_id and company_id = v_company_id for update;
  if not found then
    raise exception 'Línea inválida';
  end if;
  if v_line.status <> 'pending' then
    raise exception 'Esa línea ya está conciliada o ignorada';
  end if;
  select * into v_acc from public.bank_reconciliation_accounts where id = v_line.recon_account_id;
  if coalesce(array_length(v_movement_ids, 1), 0) + coalesce(array_length(v_payment_ids, 1), 0) = 0 then
    raise exception 'Elegí al menos un movimiento';
  end if;
  if v_fee < 0 or (v_fee > 0 and v_line.amount < 0) then
    raise exception 'Comisión inválida';
  end if;
  if v_fee <> 0 and v_adjustment <> 0 then
    raise exception 'Una comisión o un ajuste, no los dos';
  end if;

  if array_length(v_movement_ids, 1) is not null then
    select count(*), coalesce(sum(case when m.direction = 'in' then m.amount else -m.amount end), 0), min(m.branch_id::text)::uuid
    into v_count, v_part, v_branch_id
    from public.treasury_movements m
    where m.id = any(v_movement_ids) and m.company_id = v_company_id
      and m.account_id = any(v_acc.treasury_account_ids)
      and not exists (select 1 from public.bank_line_matches bm where bm.movement_id = m.id);
    if v_count <> array_length(v_movement_ids, 1) then
      raise exception 'Algún movimiento no es de estas cuentas o ya está conciliado';
    end if;
    v_total := v_total + v_part;
  end if;

  if array_length(v_payment_ids, 1) is not null then
    select count(*), coalesce(sum(p.amount), 0), coalesce(v_branch_id, min(s.branch_id::text)::uuid)
    into v_count, v_part, v_branch_id
    from public.pos_sale_payments p
    join public.pos_sales s on s.id = p.sale_id
    where p.id = any(v_payment_ids) and s.company_id = v_company_id and s.voided_at is null
      and p.account_id = any(v_acc.treasury_account_ids)
      and not exists (select 1 from public.bank_line_matches bm where bm.payment_id = p.id);
    if v_count <> array_length(v_payment_ids, 1) then
      raise exception 'Algún cobro no es de estas cuentas o ya está conciliado';
    end if;
    v_total := v_total + v_part;
  end if;

  if abs(v_adjustment) > greatest(500, abs(v_total) * 0.02) then
    raise exception 'La diferencia es demasiado grande para un ajuste (% sobre %). Revisá que sea el mismo cobro.', v_adjustment, v_total;
  end if;
  if v_total - v_fee + v_adjustment <> v_line.amount then
    raise exception 'No cierra: el banco dice % y lo elegido suma % (comisión %, ajuste %)', v_line.amount, v_total, v_fee, v_adjustment;
  end if;

  if v_fee > 0 then
    insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, category, occurred_on, notes, created_by)
    values (v_company_id, v_branch_id, v_acc.main_treasury_account_id, 'out', v_fee, 'gasto', 'otro', v_line.line_date,
            left('Comisión y retenciones del banco (conciliación): ' || v_line.description, 300), v_user_id)
    returning id into v_created_movement_id;
  elsif v_adjustment <> 0 then
    insert into public.treasury_movements (company_id, branch_id, account_id, direction, amount, movement_type, category, occurred_on, notes, created_by)
    values (v_company_id, v_branch_id, v_acc.main_treasury_account_id,
            case when v_adjustment > 0 then 'in' else 'out' end, abs(v_adjustment), 'ajuste', null, v_line.line_date,
            left('Diferencia de cobro (conciliación): ' || v_line.description, 300), v_user_id)
    returning id into v_created_movement_id;
  end if;

  insert into public.bank_line_matches (line_id, movement_id, company_id)
  select p_line_id, unnest(v_movement_ids), v_company_id;
  insert into public.bank_line_matches (line_id, payment_id, company_id)
  select p_line_id, unnest(v_payment_ids), v_company_id;

  update public.bank_statement_lines
  set status = 'matched', created_movement_id = v_created_movement_id, matched_by = v_user_id, matched_at = now()
  where id = p_line_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'bank_statement.match', 'bank_statement_line', p_line_id::text,
          jsonb_build_object('movements', to_jsonb(v_movement_ids), 'payments', to_jsonb(v_payment_ids), 'fee', v_fee, 'adjustment', v_adjustment));
end;
$$;

revoke all on function public.confirm_bank_match(uuid, uuid[], uuid[], numeric, numeric) from public, anon;
grant execute on function public.confirm_bank_match(uuid, uuid[], uuid[], numeric, numeric) to authenticated;

-- En lote: [{line_id, movement_ids, payment_ids, adjustment}] (todo o nada).
create or replace function public.confirm_bank_matches(p_matches jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 5000 then
    raise exception 'Lista de coincidencias inválida';
  end if;
  for v_match in select * from jsonb_array_elements(p_matches)
  loop
    perform public.confirm_bank_match(
      (v_match->>'line_id')::uuid,
      array(select jsonb_array_elements_text(coalesce(v_match->'movement_ids', '[]'::jsonb))::uuid),
      array(select jsonb_array_elements_text(coalesce(v_match->'payment_ids', '[]'::jsonb))::uuid),
      0,
      coalesce((v_match->>'adjustment')::numeric, 0)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.confirm_bank_matches(jsonb) from public, anon;
grant execute on function public.confirm_bank_matches(jsonb) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('105_bank_reconciliation_tolerance') on conflict do nothing;
