-- Pruebas de la migración 184 (venta sin internet subida a otro turno). Se deshace al final.
\set ON_ERROR_STOP 1
begin;
do $$
begin
  if to_regclass('public.pos_sale_offline_moves') is null then
    raise exception 'falta la tabla pos_sale_offline_moves';
  end if;
  if exists (select 1 from pg_policies where tablename = 'pos_sale_offline_moves') then
    raise exception 'pos_sale_offline_moves no tiene que tener políticas (se usa por funciones)';
  end if;
  if has_function_privilege('anon', 'public.note_offline_sale_moved(uuid,uuid,timestamptz)', 'execute') then
    raise exception 'anon puede anotar ventas movidas';
  end if;
  if has_function_privilege('anon', 'public.list_offline_sale_moves(integer)', 'execute') then
    raise exception 'anon puede listar ventas movidas';
  end if;
  if not exists (select 1 from pg_proc where proname = 'list_offline_sale_moves' and prosrc like '%(''owner'', ''admin'')%') then
    raise exception 'list_offline_sale_moves no es solo para dueño/admin';
  end if;
end $$;
rollback;
