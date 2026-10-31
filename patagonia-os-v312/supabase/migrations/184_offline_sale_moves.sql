-- 184: Venta sin internet que se subió a OTRO turno (auditoría 29/10/2026). No cambia ningún dato existente.
--
-- Mostrador guarda las ventas hechas sin internet y las sube al volver la conexión. Si mientras tanto su turno se
-- cerró, se suben al turno abierto de la sucursal (la plata ya se cobró y tiene que figurar). Eso está bien para la
-- plata de Tesorería, pero las dos cajas quedan con una diferencia que nadie sabe explicar: la del turno cerrado tiene
-- un sobrante (la plata estaba en el cajón y la venta no) y la del turno nuevo un faltante (la venta está y la plata no).
--
-- Ahora queda anotado: qué venta, en qué turno se hizo, a cuál se subió y a qué hora se cobró de verdad. El dueño lo ve
-- en Mostrador → Control de caja ("Ventas sin internet que se subieron a otro turno"), con la parte en efectivo, para
-- explicar las dos diferencias. No se toca ninguna cuenta ni ningún turno: es solo el registro.

create table if not exists public.pos_sale_offline_moves (
  sale_id uuid primary key references public.pos_sales(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  branch_id uuid not null,
  original_shift_id uuid not null references public.pos_shifts(id),
  new_shift_id uuid not null references public.pos_shifts(id),
  sold_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists pos_sale_offline_moves_company_idx on public.pos_sale_offline_moves (company_id, created_at desc);
alter table public.pos_sale_offline_moves enable row level security;
-- Sin políticas: se escribe con note_offline_sale_moved y se lee con list_offline_sale_moves.
do $mig$
begin
  if exists (select 1 from pg_proc where proname = 'accountant_readonly_guard') then
    execute 'drop trigger if exists zz_accountant_readonly on public.pos_sale_offline_moves';
    execute 'create trigger zz_accountant_readonly before insert or update or delete on public.pos_sale_offline_moves for each statement execute function public.accountant_readonly_guard()';
  end if;
end
$mig$;

-- Mostrador (cualquier rol que vende) avisa que subió una venta guardada a otro turno.
create or replace function public.note_offline_sale_moved(p_sale_id uuid, p_original_shift_id uuid, p_sold_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_sale public.pos_sales%rowtype;
begin
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  select company_id into v_company_id from public.profiles where id = v_user_id and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  select * into v_sale from public.pos_sales where id = p_sale_id and company_id = v_company_id;
  if not found then
    raise exception 'Venta inválida';
  end if;
  if v_sale.pos_shift_id is null or v_sale.pos_shift_id = p_original_shift_id then
    return;
  end if;
  if not exists (
    select 1 from public.pos_shifts
    where id = p_original_shift_id and company_id = v_company_id and branch_id = v_sale.branch_id
  ) then
    raise exception 'Turno inválido';
  end if;

  insert into public.pos_sale_offline_moves (sale_id, company_id, branch_id, original_shift_id, new_shift_id, sold_at, created_by)
  values (
    v_sale.id, v_company_id, v_sale.branch_id, p_original_shift_id, v_sale.pos_shift_id,
    -- La hora que dice la computadora, solo si es razonable (no después de subirla ni más de 30 días antes).
    case when p_sold_at <= now() and p_sold_at > v_sale.created_at - interval '30 days' then p_sold_at end,
    v_user_id
  )
  on conflict (sale_id) do nothing;

  if found then
    insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
    values (v_company_id, v_user_id, 'pos_sale.offline_moved', 'pos_sale', v_sale.id::text,
            jsonb_build_object('original_shift_id', p_original_shift_id, 'new_shift_id', v_sale.pos_shift_id, 'sold_at', p_sold_at));
  end if;
end;
$$;
revoke all on function public.note_offline_sale_moved(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.note_offline_sale_moved(uuid, uuid, timestamptz) to authenticated;

-- Control de caja (dueño o administrador): las de los últimos p_days días.
create or replace function public.list_offline_sale_moves(p_days integer default 30)
returns table (
  sale_id uuid,
  branch_id uuid,
  total numeric,
  cash_amount numeric,
  voided boolean,
  sold_at timestamptz,
  uploaded_at timestamptz,
  original_opened_at timestamptz,
  original_closed_at timestamptz,
  original_cashier text,
  new_opened_at timestamptz,
  new_cashier text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_role text;
begin
  select company_id, role into v_company_id, v_role from public.profiles where id = auth.uid() and active = true;
  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Solo el dueño o un administrador';
  end if;

  return query
  select
    m.sale_id,
    m.branch_id,
    s.total,
    coalesce((
      select sum(pp.amount) from public.pos_sale_payments pp
      join public.treasury_accounts ta on ta.id = pp.account_id
      where pp.sale_id = s.id and ta.payment_method = 'cash'
    ), 0),
    s.voided_at is not null,
    m.sold_at,
    s.created_at,
    o.opened_at,
    o.closed_at,
    coalesce(oe.full_name, nullif(o.cashier_name, ''), op.full_name),
    n.opened_at,
    coalesce(ne.full_name, nullif(n.cashier_name, ''), np.full_name)
  from public.pos_sale_offline_moves m
  join public.pos_sales s on s.id = m.sale_id
  join public.pos_shifts o on o.id = m.original_shift_id
  join public.pos_shifts n on n.id = m.new_shift_id
  left join public.employees oe on oe.id = o.cashier_employee_id
  left join public.profiles op on op.id = o.opened_by
  left join public.employees ne on ne.id = n.cashier_employee_id
  left join public.profiles np on np.id = n.opened_by
  where m.company_id = v_company_id
    and m.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
  order by m.created_at desc;
end;
$$;
revoke all on function public.list_offline_sale_moves(integer) from public, anon;
grant execute on function public.list_offline_sale_moves(integer) to authenticated;

insert into public.schema_migrations (version) values ('184_offline_sale_moves') on conflict do nothing;
