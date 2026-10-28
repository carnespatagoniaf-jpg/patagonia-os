# Publicar desde GitHub (sin depender de una computadora)

Preparado el 2026-10-28. **Todo está APAGADO** hasta que se completen los pasos de abajo.
Mientras tanto se sigue publicando como siempre desde la PC (ver "Deployment" en CLAUDE.md).

## Qué hay

| Flujo (Actions) | Cuándo corre | Qué hace | Toca clientes |
|---|---|---|---|
| **CI** (`.github/workflows/ci.yml`) | Solo, en cada push a cualquier rama y en cada PR | Pruebas (dominio + web), tipos, compilación, y **todas las migraciones desde cero en una base vacía** + `tests/sql/*.sql` | No. No usa ninguna clave |
| **Publicar** (`.github/workflows/publicar.yml`) | Solo a mano, desde `main`, con `PUBLICAR_HABILITADO=true` y aprobación del entorno `produccion` | `borrador`: pruebas → compila → borrador en Netlify (no lo ven los clientes) → pruebas de humo contra el borrador. `produccion`: publica ESE borrador (pide escribir PUBLICAR) | Solo el paso `produccion` |
| **Supabase** (`.github/workflows/supabase.yml`) | Solo a mano, desde `main`, con `SUPABASE_FLUJO_HABILITADO=true` | `revisar` lista migraciones pendientes (no cambia nada); `aplicar` las aplica una por una; `help-chat` despliega esa función. En producción pide aprobación + escribir APLICAR | Solo `aplicar`/`help-chat` en producción |

Nada se publica por cada cambio: el CI solo verifica.

Scripts:
- `scripts/ci/check-migrations.sh`: base vacía local + 001…última + pruebas SQL. Se niega a correr contra un host que no sea local.
- `scripts/ci/apply-migrations.sh revisar|aplicar`: usa `public.schema_migrations` (de la 099 en adelante). Frena si falta una migración más vieja que la última aplicada (hueco) o si dos archivos nuevos comparten número.
- `scripts/deploy-netlify.mjs draft|publish`: el mismo de siempre.

## Lo que hay que configurar a mano (en este orden)

No pegar ninguna clave en un chat. Todo se carga en GitHub → repositorio → **Settings**.

1. **Entornos** (Settings → Environments). Crearlos ANTES de habilitar nada, porque un entorno que no existe GitHub lo crea solo y sin aprobación:
   - `produccion`: *Required reviewers* = vos; *Deployment branches* = solo `main`.
   - `staging`: *Deployment branches* = solo `main` (sin aprobación, o con aprobación si preferís).
2. **Secretos del entorno `produccion`**:
   - `NETLIFY_AUTH_TOKEN`: token personal creado en la cuenta de Netlify **francisco-nesii** (la dueña del sitio).
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SENTRY_DSN`: los MISMOS valores que hoy usa la PC para compilar (sus archivos `.env`).
   - `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD` (y opcional `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`): una cuenta de prueba, NO la de un cliente.
   - `SUPABASE_DB_URL`: conexión a la base de producción (Supabase → Project Settings → Database → Connection string, "Session pooler").
   - `SUPABASE_ACCESS_TOKEN`: solo si se va a desplegar help-chat desde GitHub.
3. **Variables del entorno `produccion`**: `VITE_HELP_CHAT=1`, `SUPABASE_PROJECT_REF=tayylvhfmoybchutybcz`.
4. **Secretos/variables del entorno `staging`**: `SUPABASE_DB_URL` (base de pruebas `loquhcwsvsbqpinefxcc`), `SUPABASE_ACCESS_TOKEN`, variable `SUPABASE_PROJECT_REF=loquhcwsvsbqpinefxcc`.
5. **Proteger `main`** (Settings → Branches → Add rule): exigir que pasen *Pruebas, tipos y compilación* y *Migraciones desde cero + pruebas SQL* antes de unir.
6. Recién después de comprobar todo (abajo): variables del repositorio `PUBLICAR_HABILITADO=true` y `SUPABASE_FLUJO_HABILITADO=true`.

La configuración de Netlify no se toca: el sitio sigue igual y el flujo solo usa su API, como hoy la PC.

## Cómo se comprueba antes de habilitar

1. **CI**: tiene que estar en verde en `main` (hoy lo está en la rama de trabajo).
2. **Supabase en staging, solo lectura**: habilitar `SUPABASE_FLUJO_HABILITADO`, correr *Supabase* con `destino=staging, accion=revisar`. Tiene que listar lo que le falta a staging sin cambiar nada. Comparar con lo que dice la PC (`select version from schema_migrations`).
3. **Supabase en producción, solo lectura**: `destino=produccion, accion=revisar`. Tiene que decir qué falta (hoy: la 167) y NO aplicar nada.
4. **Aplicar en staging** (`accion=aplicar`), probar a mano en staging (una venta mayorista, cierre de caja).
5. **Borrador de Netlify**: habilitar `PUBLICAR_HABILITADO`, correr *Publicar* con `paso=borrador`. Abrir la URL del borrador, entrar con la cuenta de prueba, revisar Mostrador, Stock y Clientes. Comparar con la página real: tiene que verse igual (mismo chat de ayuda, misma base).
6. Primera publicación real: elegir un horario sin ventas, `paso=produccion` con el id del borrador. Si algo sale mal: Netlify → Deploys → el anterior → "Publish deploy" (vuelve en segundos; la base no cambia).
7. Recién ahí dejar de publicar desde la PC.
