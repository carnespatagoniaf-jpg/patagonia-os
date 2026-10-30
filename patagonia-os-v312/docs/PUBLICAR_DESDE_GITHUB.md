# Publicación automática desde GitHub

GitHub es el único lugar central. Desde cualquier computadora (o desde Claude en la nube) se trabaja igual:

1. Traer lo último: `git pull origin main`.
2. Hacer el cambio y subirlo a `main` (`git push origin main`).
3. GitHub hace el resto, solo:
   - **CI** (`.github/workflows/ci.yml`): pruebas, tipos, compilación, y todas las migraciones desde cero en una base vacía + `tests/sql`. Si algo falla, **no se publica**.
   - **Publicar** (`.github/workflows/publicar.yml`), solo si el CI de `main` quedó en verde:
     1. migraciones pendientes en la base de pruebas (staging);
     2. compila con los valores de producción, sube un **borrador** a Netlify (los clientes no lo ven) y le corre las pruebas de humo (solo lectura);
     3. base de producción: guarda la estructura (sin datos de clientes) como respaldo de 90 días y aplica las migraciones pendientes. **Frena** si una migración borra o cambia datos, o si falta una migración vieja: eso se revisa y se aplica a mano con el flujo *Supabase*;
     4. despliega la función help-chat (staging y producción);
     5. publica el borrador y vuelve a probar la página real; **si falla, vuelve sola a la versión anterior**.

Ya no se publica desde la PC (ni `netlify deploy` ni `supabase functions deploy`): hacerlo saltearía las pruebas.

## Volver atrás

- **Página**: Actions → *Volver atrás* → Run workflow (vacío = la versión anterior; o el id que figura en el resumen de cada *Publicar*). También desde Netlify → Deploys → la versión → "Publish deploy".
- **Base de datos**: no se deshace sola. Por eso solo se aplican solas migraciones que agregan (tablas, columnas, funciones). Antes de cada cambio queda la estructura anterior como archivo descargable en la corrida de *Publicar*. Los datos los respalda Supabase (Database → Backups).

## Herramientas manuales

- *Supabase* (`supabase.yml`): `revisar` (qué le falta a staging o producción, sin cambiar nada), `aplicar` (para una migración que la publicación automática frenó; en producción hay que escribir APLICAR), `help-chat`.
- *Volver atrás* (`volver-atras.yml`).

## Configuración (una sola vez)

GitHub → repositorio → **Settings**. Las claves se cargan ahí, nunca en el código ni en un chat.

1. **Environments → New environment `staging`**
   - Secreto `SUPABASE_DB_URL`: Supabase (proyecto `loquhcwsvsbqpinefxcc`) → Project Settings → Database → Connection string → "Session pooler" (con la contraseña de la base).
   - *Deployment branches*: solo `main`.
2. **Environments → New environment `produccion`** (sin "Required reviewers": la publicación es automática)
   - *Deployment branches*: solo `main`.
   - Secretos:
     - `NETLIFY_AUTH_TOKEN`: Netlify, cuenta **francisco-nesii** → User settings → Applications → Personal access tokens → New.
     - `VITE_SUPABASE_URL` = `https://tayylvhfmoybchutybcz.supabase.co`, `VITE_SUPABASE_ANON_KEY`, `VITE_SENTRY_DSN`: los mismos que usa hoy la PC para compilar (sus archivos `.env`).
     - `SUPABASE_DB_URL`: igual que staging pero del proyecto `tayylvhfmoybchutybcz`.
     - `SUPABASE_ACCESS_TOKEN`: Supabase → Account → Access Tokens.
     - `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD`: una cuenta de PRUEBA (no de un cliente) para las pruebas de humo. Opcional: `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`.
   - Variables: `VITE_HELP_CHAT` = `1`, `SUPABASE_PROJECT_REF` = `tayylvhfmoybchutybcz`, `SUPABASE_STAGING_REF` = `loquhcwsvsbqpinefxcc`.
3. **Branches → Add rule para `main`**: no permitir borrarla ni forzar (force push).
4. **Secrets and variables → Actions → Variables (del repositorio)**: `AUTOPUBLICAR` = `true`. Es el interruptor general: sin ella nada se publica. Para frenar todo de golpe, ponerla en `false`.

## Primera vez

La primera corrida de *Publicar* conviene lanzarla a mano (Actions → Publicar → Run workflow) en un horario sin ventas y mirar cada paso. Si el borrador o las pruebas fallan, nada llega a los clientes.
