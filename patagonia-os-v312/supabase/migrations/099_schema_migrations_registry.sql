-- Registro de migraciones: hasta ahora no habia forma de saber, mirando un
-- proyecto de Supabase, que migraciones ya tiene aplicadas -- eso llevo a que
-- staging se atrasara sin que nadie lo notara (le falto la 091 varios dias,
-- hasta que goteo un bug real: get_branches_overview de la 098 dependia de
-- today_ar()).
--
-- Esta tabla NO se llena retroactivamente para 001-098: no hay forma
-- confiable de saber desde afuera cuales de esas quedaron aplicadas en cada
-- proyecto sin auditarlas una por una, y anotar "aplicada" a ciegas seria
-- peor que no tener registro. Se arranca limpio desde esta (099) en
-- adelante: CADA migracion nueva, en su ULTIMA linea, tiene que hacer
--   insert into public.schema_migrations (version) values ('NNN_nombre') on conflict do nothing;
-- Antes de asumir que dos proyectos (produccion/staging) estan al mismo
-- nivel, comparar:
--   select version from public.schema_migrations order by version;
-- en los dos y ver que falta.
--
-- No es una tabla de negocio: nadie la lee ni la escribe desde el cliente,
-- solo se toca al aplicar una migracion (por eso RLS sin ninguna politica,
-- ni siquiera de lectura -- ni anon ni authenticated pueden verla).
create table if not exists public.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;

insert into public.schema_migrations (version) values ('099_schema_migrations_registry') on conflict do nothing;
