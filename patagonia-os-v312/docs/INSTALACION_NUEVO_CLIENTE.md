# Checklist de instalación para un cliente nuevo

## Camino A (default): alta en la base compartida

Desde que existe el modelo multi-tenant (`platform_admins` +
`create-client`, migración `025_platform_admins.sql`), **dar de alta un
cliente nuevo no requiere Supabase ni Netlify nuevos**. Todos los clientes
viven en el mismo proyecto/base, aislados por empresa (RLS por
`company_id`, ya probado con dos empresas reales conviviendo sin verse
entre sí).

Pasos:

1. Entrá al sitio con tu login de **platform admin** (el que se dio de alta
   una vez con `supabase/seed/create_platform_admin.sql`).
2. Vas a caer directo en la pantalla **"Dar de alta un cliente"**.
3. Completá: nombre del negocio, nombre de la primera sucursal, nombre y
   email del dueño → **Crear cliente**.
4. Te muestra el email y una **contraseña temporal** — pasásela al dueño
   (una sola vez, no se puede volver a ver). Recomendale cambiarla
   apenas entre, desde "Cambiar contraseña" en el menú.
5. Listo. El dueño ya puede loguearse, y desde ahí usa la app normalmente
   (agregar sucursales, usuarios, productos, etc. — todo lo de siempre).

Si en algún momento el cliente necesita más de una sucursal, o más
usuarios, eso lo hace él mismo desde la app ("+ Nueva sucursal", "+ Nuevo
usuario") — no vuelve a este checklist.

## Camino B: instalación aislada (Supabase y sitio propios)

Este es el camino que se usaba antes de tener multi-tenant. Sigue
disponible para el caso puntual de un cliente que exija su propia
infraestructura separada (por ejemplo, por un requisito de
confidencialidad/compliance específico), pero **ya no es el default** —
implica mantener un proyecto Supabase y un sitio Netlify más por cada
cliente así.

Esto se hace **una sola vez por cliente** (una carnicería = un proyecto de
Supabase propio + un sitio propio en Netlify). Agregar sucursales, usuarios o
empleados a un cliente que ya está instalado **no** requiere repetir nada de
esto — eso se hace todo desde la app (botones "+ Nueva sucursal" y "+ Nuevo
usuario").

Tiempo estimado: 30–45 minutos la primera vez.

---

## 0. Antes de empezar

Vas a necesitar:
- El nombre real del negocio y de su primera sucursal.
- El email real del dueño (para su login).
- Acceso a [supabase.com](https://supabase.com) y [app.netlify.com](https://app.netlify.com).

---

## 1. Crear el proyecto en Supabase

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Elegí una contraseña de base de datos fuerte y guardala en un lugar seguro
   (gestor de contraseñas) — no hace falta para lo que sigue, pero es la
   llave maestra del proyecto.
3. Esperá a que el proyecto termine de aprovisionarse (~2 minutos).

## 2. Correr las migraciones, en orden

En **SQL Editor**, pegá y ejecutá cada archivo de `supabase/migrations/`,
**uno por uno, en este orden exacto** (cada uno depende de que el anterior ya
haya corrido):

```
001_core.sql
002_security.sql
003_auth_and_sale_transaction.sql
004_security_complete.sql
005_open_cash_session.sql
006_close_cash_session.sql
007_suppliers_purchases.sql
008_treasury_and_shifts.sql
009_fix_treasury_balance_view.sql
010_treasury_adjustments.sql
011_reset_test_data.sql        ← no hace nada en un proyecto nuevo (borra
                                   filas de tablas que todavía están vacías),
                                   pero no rompe nada si lo corrés igual.
012_shift_sales_as_entries.sql
013_employees_payroll.sql
014_fix_voucher_liquidation_window.sql
015_link_vouchers_to_liquidation.sql
016_link_supplier_payments_from_shifts.sql
017_profitability.sql
018_stock_counts.sql
019_product_costs.sql
020_carcass_costing.sql
021_creditors.sql
022_create_branch.sql
023_adjust_product_stock.sql
024_update_staff_user.sql
```

(`025_platform_admins.sql` no hace falta acá — es solo para la base
compartida del Camino A, donde un mismo proyecto aloja más de un cliente.)

Si alguno tira error, no sigas con el siguiente hasta resolverlo — están
pensados para depender de que todo lo anterior haya quedado bien.

## 3. Crear la empresa y su primera sucursal

Abrí `supabase/seed/new_client_bootstrap.sql`, reemplazá:
- `'NOMBRE DEL NEGOCIO'` por el nombre real del negocio.
- `'NOMBRE DE LA PRIMERA SUCURSAL'` por el nombre real del local (ej. "Haedo").

Ejecutalo en el SQL Editor. Te va a devolver dos columnas: `company_id` y
`branch_id`. **Copiá esos dos UUID**, los necesitás en el paso siguiente.

## 4. Crear el usuario dueño

1. En Supabase, **Authentication → Users → Add user**.
2. Cargá el email real del dueño, poné una contraseña temporal, y marcá el
   email como confirmado ("Auto Confirm User").
3. Copiá el **UUID** de ese usuario recién creado.
4. Abrí `supabase/seed/create_owner_profile.sql`, y reemplazá:
   - `USER_UUID` → el UUID del usuario (paso 3).
   - el `company_id` hardcodeado → el `company_id` del paso 2.
   - el `branch_id` hardcodeado → el `branch_id` del paso 2.
   - `'Francisco'` → el nombre real del dueño.
5. Ejecutalo en el SQL Editor.

## 5. Publicar la Edge Function de usuarios

Esta función es genérica — es el mismo código para todos los clientes, no
hay que tocarla.

1. Supabase Dashboard → **Edge Functions** → "Deploy a new function".
2. Nombre exacto: `create-staff-user`.
3. Pegá el contenido completo de `supabase/functions/create-staff-user/index.ts`.
4. Deploy. No hace falta configurar variables de entorno: `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` ya están disponibles
   automáticamente en toda función de ese proyecto.

## 6. Copiar las claves del proyecto

Supabase Dashboard → **Settings → API**. Vas a necesitar:
- **Project URL** → va a `VITE_SUPABASE_URL`.
- **anon public key** → va a `VITE_SUPABASE_ANON_KEY`.

⚠️ La **service_role key** de esa misma pantalla **nunca** va en Netlify ni en
ningún archivo `VITE_*` — la Edge Function ya la usa internamente sola, sin
que nadie la copie a mano.

## 7. Publicar el sitio en Netlify

1. Subí este repositorio a un GitHub del cliente (o a uno propio si vas a
   administrarlo vos).
2. En Netlify: **Add new site → Import an existing project**, vinculá el repo.
3. Build command: `npm run build`
4. Publish directory: `apps/web/dist`
5. En **Site settings → Environment variables**, cargá las dos claves del
   paso 6 (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
6. Deploy.

(Conectar el repo a Netlify de esta forma es mejor que el drag-and-drop
manual que usamos para Carnes Patagonia: cada `git push` deja el sitio
actualizado solo, sin que tengas que subir el build a mano cada vez.)

## 8. Primer login y verificación

Entrá al sitio recién publicado con el email/contraseña del dueño (paso 4) y
confirmá, en este orden:

1. **Login funciona** y el menú muestra el nombre y rol correctos.
2. **Stock**: cargar un producto de prueba.
3. **Tesorería**: crear las cuentas reales (Efectivo, Mercado Pago, Banco,
   etc.) con su saldo inicial real — esto se hace desde la app, no por SQL.
4. **Usuarios**: crear un segundo usuario (ej. un encargado) y confirmar que
   la contraseña temporal permite loguearse.
5. **Sucursales**: si el negocio tiene más de un local, crear el resto desde
   "+ Nueva sucursal" y confirmar que el selector cambia de sucursal
   correctamente.
6. Cambiar la contraseña temporal del dueño por una definitiva (Supabase no
   tiene un flujo de "olvidé mi contraseña" configurado por default — se
   cambia desde Authentication → Users → ese usuario → "Send password
   recovery" o reseteándola a mano ahí mismo).

Con eso el cliente queda operativo. De acá en más, todo lo demás (más
sucursales, más usuarios, catálogo de productos, compras, etc.) se hace
desde la app, sin volver a tocar SQL.
