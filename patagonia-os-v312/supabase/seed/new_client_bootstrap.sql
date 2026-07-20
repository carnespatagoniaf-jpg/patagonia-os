-- Plantilla para dar de alta un cliente nuevo (una carnicería nueva, con su
-- propio proyecto Supabase). Reemplazá los dos nombres de más abajo por los
-- reales antes de ejecutar. Se corre UNA sola vez, después de las
-- migraciones 001 a 024 y antes de crear el usuario dueño.
--
-- Devuelve company_id y branch_id: ANOTALOS, los vas a necesitar en el
-- siguiente paso (supabase/seed/create_owner_profile.sql).

with new_company as (
  insert into public.companies (name)
  values ('NOMBRE DEL NEGOCIO')
  returning id
),
new_branch as (
  insert into public.branches (company_id, name)
  select id, 'NOMBRE DE LA PRIMERA SUCURSAL' from new_company
  returning id, company_id
)
select
  new_branch.company_id as company_id,
  new_branch.id as branch_id
from new_branch;
