# Despliegue

## Netlify

1. Subir este repositorio a GitHub.
2. En Netlify vincular el repositorio.
3. Build command: `npm run build -w @patagonia/web`
4. Publish directory: `apps/web/dist`
5. Configurar:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

## Supabase

1. Crear un proyecto.
2. Ejecutar migraciones por orden.
3. Crear el usuario dueño.
4. Insertar su perfil con empresa, sucursal y rol.
5. Probar RLS con dos usuarios diferentes.

## Seguridad

Nunca configurar `SUPABASE_SERVICE_ROLE_KEY` en variables que empiecen con `VITE_`.
