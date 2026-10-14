-- Reversión de la 119 (venta con balanza "artículos + TOTAL"). Probada en STAGING antes de usarse en producción.
--
-- Primero se usa el INTERRUPTOR, no esto: set_scale_profile_active(..., false) apaga la función en una sucursal sin
-- borrar nada. Esta reversión es para sacar la función de la base entera (por ejemplo, si se vuelve la web a una
-- versión anterior a la 119 y no se la quiere dejar instalada).
--
-- Qué NO toca: las ventas (pos_sales, pos_sale_items, pos_sale_payments), el stock (inventory_movements), la
-- tesorería y la auditoría. Las ventas cobradas con balanza siguen siendo ventas normales con su stock descontado.
-- Lo único que se pierde es el registro de qué papel de balanza fue cada venta (pos_scale_paper_claims) y el
-- catálogo y vínculos de la balanza (se vuelven a cargar con "Leer la balanza" + "Guardar").
-- Antes de correrla se guarda una copia de esas 3 tablas (bloque 1).

-- 1. Copia de seguridad dentro de la misma base (se borra a mano cuando ya no haga falta).
create table if not exists public.bak_119_scale_profiles as table public.scale_profiles;
create table if not exists public.bak_119_scale_catalog_items as table public.scale_catalog_items;
create table if not exists public.bak_119_pos_scale_paper_claims as table public.pos_scale_paper_claims;
alter table public.bak_119_scale_profiles enable row level security;
alter table public.bak_119_scale_catalog_items enable row level security;
alter table public.bak_119_pos_scale_paper_claims enable row level security;

-- 2. Funciones y tablas de la 119.
drop function if exists public.create_pos_scale_sale(uuid, jsonb, jsonb, uuid, numeric, numeric, uuid, text, jsonb);
drop function if exists public.set_scale_links(uuid, text, jsonb);
drop function if exists public.save_scale_catalog(uuid, text, jsonb, jsonb);
drop function if exists public.set_scale_repeat_window(uuid, text, int);
drop function if exists public.set_scale_profile_active(uuid, text, boolean);
drop table if exists public.pos_scale_paper_claims;
drop table if exists public.scale_catalog_items;
drop table if exists public.scale_profiles;
delete from public.schema_migrations where version = '119_scale_sale_papers';
