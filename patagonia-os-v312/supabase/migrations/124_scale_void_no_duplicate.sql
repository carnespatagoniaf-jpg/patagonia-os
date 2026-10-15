-- 124: "Anular ticket de balanza" no deja anular dos veces el mismo papel.
--
-- Por qué (real, Haedo 13/10 mañana): el ticket 2000901013046 ($9.780) se escaneó dos veces en
-- "Anular ticket" con 75 segundos de diferencia y quedó restado dos veces en el control de la balanza.
-- Ahora, si ese mismo código ya está anulado en los turnos que abarca el control (scale_control_window:
-- desde el último borrado de la balanza), se rechaza. El resto de la función queda igual.

create or replace function public.void_scale_ticket(p_pos_shift_id uuid, p_barcode text, p_plu text, p_product_id uuid, p_weight_kg numeric, p_amount numeric, p_reason text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ctx record;
  v_id uuid;
begin
  select * into v_ctx from public.scale_control_caller(p_pos_shift_id);
  if v_ctx.shift_status <> 'open' then
    raise exception 'El turno ya está cerrado';
  end if;
  if coalesce(trim(p_barcode), '') = '' then
    raise exception 'Falta el código del ticket';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Importe inválido';
  end if;
  if p_product_id is not null and not exists (select 1 from public.products where id = p_product_id and company_id = v_ctx.company_id) then
    raise exception 'Producto inválido';
  end if;

  -- 124: el mismo papel no se anula dos veces (un candado por sucursal evita dos clics a la vez).
  perform pg_advisory_xact_lock(hashtext('scale_void:' || v_ctx.branch_id::text));
  if exists (
    select 1 from public.scale_ticket_voids
    where pos_shift_id = any(public.scale_control_window(p_pos_shift_id))
      and barcode = left(trim(p_barcode), 60)
  ) then
    raise exception 'Ese ticket ya está anulado';
  end if;

  insert into public.scale_ticket_voids (company_id, branch_id, pos_shift_id, barcode, plu, product_id, weight_kg, amount, reason, voided_by)
  values (v_ctx.company_id, v_ctx.branch_id, p_pos_shift_id, left(trim(p_barcode), 60), left(p_plu, 20), p_product_id,
          p_weight_kg, round(p_amount, 2), nullif(left(trim(coalesce(p_reason, '')), 200), ''), auth.uid())
  returning id into v_id;

  insert into public.audit_log (company_id, branch_id, user_id, action, entity_type, entity_id, new_data)
  values (v_ctx.company_id, v_ctx.branch_id, auth.uid(), 'scale_ticket.void', 'scale_ticket_void', v_id::text,
          jsonb_build_object('barcode', p_barcode, 'amount', p_amount, 'weight_kg', p_weight_kg, 'pos_shift_id', p_pos_shift_id));

  return v_id;
end;
$function$;

revoke all on function public.void_scale_ticket(uuid, text, text, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.void_scale_ticket(uuid, text, text, uuid, numeric, numeric, text) to authenticated;

insert into public.schema_migrations (version) values ('124_scale_void_no_duplicate') on conflict do nothing;
