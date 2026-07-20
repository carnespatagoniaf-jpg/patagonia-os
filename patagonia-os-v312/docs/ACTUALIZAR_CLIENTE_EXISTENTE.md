# Checklist para actualizar un cliente que ya está instalado

Esto es distinto a `docs/INSTALACION_NUEVO_CLIENTE.md`: acá el negocio ya
tiene su Supabase y su sitio funcionando con datos reales, y lo que hay que
hacer es llevarlo a la versión más nueva del código sin perder nada ni
duplicar algo que ya corrió.

Se hace **cada vez que agarrás una versión nueva del repo para un cliente
que ya venía andando** (incluida "Carnes Patagonia").

Desde que existe la base compartida (multi-tenant, ver Camino A de
`docs/INSTALACION_NUEVO_CLIENTE.md`), la mayoría de los clientes viven en
el **mismo** proyecto Supabase — actualizar ese proyecto actualiza a todos
los clientes que aloja a la vez. Este checklist sigue aplicando igual,
tanto para esa base compartida como para un cliente con instalación
aislada (Camino B).

---

## 0. Antes de tocar nada: anotá dónde está parado ese cliente

No hay una tabla que registre qué migraciones ya corrieron en el Supabase de
ese cliente — es manual. Antes de actualizar, tené a mano (en una nota, no
hace falta que sea en el repo):

- El **número de la última migración** que corriste ahí (ej. "024").
- El **commit** o fecha del último deploy de ese sitio.

Si no lo tenés anotado de antes, podés inferirlo corriendo esto en su
SQL Editor y viendo qué funciones/tablas ya existen (por ejemplo, si
`update_staff_user` ya existe, ya corrió la 024):

```sql
select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name in (
  'create_branch', 'adjust_product_stock', 'update_staff_user'
);
```

## 1. Ver qué cambió

```bash
git log --oneline <lo-que-tenían-antes>..HEAD
ls supabase/migrations/       # confirmá el número más alto
ls supabase/functions/        # ¿hay alguna nueva o modificada?
```

## 2. Correr **solo** las migraciones nuevas

Nunca vuelvas a correr desde `001` en un cliente con datos reales. Corré,
en el SQL Editor de **ese** proyecto, únicamente los archivos numerados
después de la última que ya tenía — en orden.

Dos cosas para tener en cuenta migración por migración:

- La gran mayoría son `create or replace function` / `create table if not
  exists` / vistas — son **seguras de re-correr** si por error corrés una
  de más, no rompen nada.
- Ojo con los scripts de `supabase/seed/` y con cualquier migración que sea
  puro `delete from ...` sin `create or replace` (como fue puntualmente
  `011_reset_test_data.sql`, un script de limpieza de datos de prueba, no
  una migración de esquema reusable) — **esos si los corrés en un cliente
  con datos reales, borran datos reales**. Si una migración nueva es de
  este tipo, léela entera antes de correrla y confirmá que aplica a este
  cliente.

## 3. Edge Functions nuevas o modificadas

Si `supabase/functions/` tiene una función que no existía antes, o el
contenido de una que ya existe cambió:

- Función nueva: Dashboard → Edge Functions → "Deploy a new function",
  mismo nombre exacto que la carpeta, pegar el código.
- Función existente modificada: Dashboard → Edge Functions → esa función →
  reemplazar el código → Deploy. Se sobreescribe, no hace falta borrar la
  anterior.

## 4. Variables de entorno nuevas

Si el update agrega alguna variable nueva (comparar `.env.example` con lo
que ya tenías), cargarla en Netlify (**Site settings → Environment
variables**) antes del siguiente deploy. Nunca una `SUPABASE_SERVICE_ROLE_KEY`
con prefijo `VITE_`.

## 5. Publicar el frontend actualizado

- Si el sitio de ese cliente está **conectado a su GitHub** (auto-deploy):
  alcanza con pushear a su rama de producción — Netlify lo toma solo.
- Si es **deploy manual** (como Carnes Patagonia hoy): `npm run build` y
  arrastrar `apps/web/dist` de nuevo al panel de Netlify, igual que
  siempre.

## 6. Verificar

No hace falta repetir todo el checklist de instalación — probá puntualmente
lo que cambió en esta versión (por ejemplo: si el update agregó "Usuarios",
entrar y crear uno de prueba; si tocó una migración de Tesorería, revisar
que los saldos no se hayan movido de forma rara). Si tenés dudas de que algo
quedó bien, comparar un total conocido (ej. el saldo de una cuenta) antes y
después del update.

## 7. Actualizá tu nota del paso 0

Guardá el número de la última migración corrida y el commit/fecha de este
deploy, para la próxima vez.
