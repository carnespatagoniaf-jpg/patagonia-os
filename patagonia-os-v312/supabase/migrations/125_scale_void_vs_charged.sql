-- 125: ticket de balanza anulado y cobrado a la vez (avisos en Mostrador + deshacer una anulación).
--
-- Por qué (real, Haedo): 6/10 Suprema 0,826 kg $11.481 cobrada 19:45 y anulada 20:24; 13/10 Oferta mila
-- 1,304 kg $9.780 anulada 14:14 y cobrada 14:24. Un papel anulado Y cobrado se resta en el control de la
-- balanza aunque se cobró: tapa un faltante real del mismo importe.
--
-- 1. find_scale_ticket_void(turno, código): ¿ese código ya está anulado en los turnos del control
--    (scale_control_window)? Mostrador lo pregunta al escanear: "Este ticket fue anulado a las HH:MM por X".
-- 2. find_scale_ticket_sale(turno, producto, kg, importe): ¿ese papel ya se cobró en los turnos del control?
--    pos_sale_items no guarda el código del papel, así que se compara: etiqueta = mismo producto + mismos kg
--    (el código de la etiqueta ES producto + kg); ticket de total = línea 'scale_total' del mismo importe.
--    "Anular ticket de balanza" lo pregunta antes de anular.
-- 3. undo_scale_ticket_void(turno, anulación): si se cobra igual, se borra la anulación para que el control
--    no la reste. Mismo esqueleto que void_scale_ticket (dueño/admin/cajero, turno abierto, auditado con
--    los datos borrados). Deshacer una anulación nunca tapa plata: el control pasa a esperar MÁS.

create or replace function public.find_scale_ticket_void(p_pos_shift_id uuid, p_barcode text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_row jsonb;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);
  if coalesce(trim(p_barcode), '') = '' then
    return null;
  end if;
  select jsonb_build_object(
           'id', v.id,
           'created_at', v.created_at,
           'amount', v.amount,
           'weight_kg', v.weight_kg,
           'reason', v.reason,
           'by', coalesce(e.full_name, p.full_name)
         ) into v_row
  from public.scale_ticket_voids v
  join public.pos_shifts s on s.id = v.pos_shift_id
  left join public.employees e on e.id = s.cashier_employee_id
  left join public.profiles p on p.id = v.voided_by
  where v.company_id = v_ctx.company_id
    and v.pos_shift_id = any(public.scale_control_window(p_pos_shift_id))
    and v.barcode = left(trim(p_barcode), 60)
  order by v.created_at desc
  limit 1;
  return v_row;
end;
$$;

revoke all on function public.find_scale_ticket_void(uuid, text) from public, anon;
grant execute on function public.find_scale_ticket_void(uuid, text) to authenticated;

create or replace function public.find_scale_ticket_sale(p_pos_shift_id uuid, p_product_id uuid, p_weight_kg numeric, p_amount numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_row jsonb;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);
  select jsonb_build_object(
           'sale_id', ps.id,
           'created_at', ps.created_at,
           'amount', i.line_total,
           'by', coalesce(e.full_name, p.full_name)
         ) into v_row
  from public.pos_sale_items i
  join public.pos_sales ps on ps.id = i.sale_id
  join public.pos_shifts s on s.id = ps.pos_shift_id
  left join public.employees e on e.id = s.cashier_employee_id
  left join public.profiles p on p.id = ps.created_by
  where ps.company_id = v_ctx.company_id
    and ps.pos_shift_id = any(public.scale_control_window(p_pos_shift_id))
    and ps.voided_at is null
    and (
      -- Etiqueta: el código es producto + kg.
      (p_product_id is not null and p_weight_kg is not null
        and i.source = 'scale' and i.product_id = p_product_id and abs(i.quantity - p_weight_kg) < 0.0005)
      -- Ticket de total cobrado sin detalle.
      or (p_product_id is null and p_amount is not null
        and i.source = 'scale_total' and abs(i.quantity * i.unit_price - p_amount) < 0.01)
    )
  order by ps.created_at desc
  limit 1;
  return v_row;
end;
$$;

revoke all on function public.find_scale_ticket_sale(uuid, uuid, numeric, numeric) from public, anon;
grant execute on function public.find_scale_ticket_sale(uuid, uuid, numeric, numeric) to authenticated;

create or replace function public.undo_scale_ticket_void(p_pos_shift_id uuid, p_void_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_old public.scale_ticket_voids;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);
  if v_ctx.shift_status <> 'open' then
    raise exception 'El turno ya está cerrado';
  end if;

  perform pg_advisory_xact_lock(hashtext('scale_void:' || v_ctx.branch_id::text));
  select * into v_old
  from public.scale_ticket_voids
  where id = p_void_id
    and company_id = v_ctx.company_id
    and pos_shift_id = any(public.scale_control_window(p_pos_shift_id))
  for update;
  if v_old.id is null then
    raise exception 'Esa anulación no existe o ya no entra en el control de la balanza';
  end if;

  delete from public.scale_ticket_voids where id = v_old.id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data)
  values (v_ctx.company_id, v_ctx.branch_id, auth.uid(), 'scale_ticket.void_undo', 'scale_ticket_void', v_old.id::text,
          to_jsonb(v_old), jsonb_build_object('pos_shift_id', p_pos_shift_id, 'motivo', 'Se cobró igual en Mostrador'));
end;
$$;

revoke all on function public.undo_scale_ticket_void(uuid, uuid) from public, anon;
grant execute on function public.undo_scale_ticket_void(uuid, uuid) to authenticated;

insert into public.schema_migrations (version) values ('125_scale_void_vs_charged') on conflict do nothing;
