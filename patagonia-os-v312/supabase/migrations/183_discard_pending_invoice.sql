-- 183: Descartar una factura que quedó "pendiente" y nunca se pidió a ARCA (auditoría 29/10/2026).
--
-- Una factura pendiente que no puede salir (por ejemplo, el negocio todavía no tiene el certificado de ARCA) quedaba
-- así para siempre: no había cómo sacarla, y en Clientes el cargo no se podía editar ni borrar porque la guarda de la
-- 136 la cuenta como factura viva. Ahora el dueño o un administrador la puede descartar (queda "rechazada", con el
-- motivo), SOLO si nunca se le pidió número a ARCA (pending_number vacío): así no puede quedar un comprobante
-- autorizado en ARCA que el sistema no conoce. Las que sí se pidieron se resuelven con el reintento, que primero
-- consulta a ARCA. Queda en Auditoría. No cambia ningún dato existente.

create or replace function public.discard_pending_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
  v_inv public.invoices%rowtype;
begin
  if v_user_id is null then raise exception 'Usuario no autenticado'; end if;
  select company_id, role into v_company_id, v_role from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then raise exception 'Perfil inválido'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador puede descartar una factura';
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id and company_id = v_company_id for update;
  if v_inv.id is null then raise exception 'Factura inválida'; end if;
  if v_inv.status <> 'pendiente' then raise exception 'Solo se puede descartar una factura pendiente'; end if;
  -- Una nota de crédito no se descarta: la factura que anula seguiría válida con la venta anulada (revisión 30/10).
  if v_inv.kind = 'nota_credito' then
    raise exception 'Una nota de crédito no se puede descartar: tocá Reintentar para que salga.';
  end if;
  if v_inv.pending_number is not null then
    raise exception 'Esta factura ya se le pidió a ARCA: no se puede descartar. Tocá Reintentar para que el sistema consulte a ARCA y la cierre.';
  end if;
  if v_inv.claimed_at is not null and v_inv.claimed_at > now() - interval '5 minutes' then
    raise exception 'Se está pidiendo en este momento desde otra caja. Probá de nuevo en unos minutos.';
  end if;

  update public.invoices
  set status = 'rechazada', error_message = 'Descartada a mano (nunca se pidió a ARCA).', claimed_at = null
  where id = p_invoice_id;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, old_data)
  values (v_company_id, v_user_id, 'invoice.discard', 'invoice', p_invoice_id::text,
          jsonb_build_object('kind', v_inv.kind, 'total', v_inv.total, 'pos_sale_id', v_inv.pos_sale_id, 'customer_charge_id', v_inv.customer_charge_id, 'error_message', v_inv.error_message));
end;
$$;
revoke all on function public.discard_pending_invoice(uuid) from public, anon;
grant execute on function public.discard_pending_invoice(uuid) to authenticated;

insert into public.schema_migrations (version) values ('183_discard_pending_invoice') on conflict do nothing;
