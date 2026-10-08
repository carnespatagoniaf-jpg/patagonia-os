-- Combos en Recetas (pedido del dueño, 2026-10-08): "1 kg milanesa de pollo +
-- 1 kg pata muslo + 1 kg hamburguesas… para sacar costos".
--
-- Un combo es una receta sin merma que rinde 1 combo: se reusa todo el costeo
-- de recetas (save_recipe, apply_recipe_to_product, recipeCost en la web) sin
-- tocarlo. Lo único nuevo es saber cuáles son combos, para mostrarlos distinto
-- (precio si se compraran sueltos, descuento del combo).
--
-- recipes.kind: 'receta' (default, todas las que existen) o 'combo'.
-- set_recipe_kind: lo marca después de save_recipe (no se cambia la firma de
-- save_recipe, que tiene require_plan inyectado en cada base).
-- Igual que recetas: plan Estándar, solo dueño y administrador. Nunca toca stock.

alter table public.recipes
  add column if not exists kind text not null default 'receta';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recipes_kind_check') then
    alter table public.recipes add constraint recipes_kind_check check (kind in ('receta', 'combo'));
  end if;
end $$;

create or replace function public.set_recipe_kind(p_recipe_id uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_role text;
begin
  perform public.require_plan('estandar');
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select company_id, role into v_company_id, v_role
  from public.profiles
  where id = v_user_id and active = true;

  if v_company_id is null then
    raise exception 'Perfil inválido';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'No autorizado para editar recetas';
  end if;

  if p_kind not in ('receta', 'combo') then
    raise exception 'Tipo inválido';
  end if;

  update public.recipes
  set kind = p_kind, updated_at = now()
  where id = p_recipe_id and company_id = v_company_id;

  if not found then
    raise exception 'Receta inválida';
  end if;

  insert into public.audit_log (company_id, user_id, action, entity_type, entity_id, new_data)
  values (v_company_id, v_user_id, 'recipe.kind', 'recipe', p_recipe_id::text, jsonb_build_object('kind', p_kind));
end;
$$;

revoke all on function public.set_recipe_kind(uuid, text) from public, anon;
grant execute on function public.set_recipe_kind(uuid, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations (version) values ('112_recipe_combos') on conflict do nothing;
