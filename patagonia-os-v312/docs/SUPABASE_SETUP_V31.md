# Configuración de Supabase V3.1

## 1. Crear el proyecto

Crear un proyecto nuevo en Supabase y guardar de manera segura la contraseña de la base.

## 2. Ejecutar SQL en este orden

1. `supabase/migrations/001_core.sql`
2. `supabase/migrations/002_security.sql`
3. `supabase/migrations/003_auth_and_sale_transaction.sql`
4. `supabase/migrations/004_security_complete.sql`
5. `supabase/seed/demo.sql`

## 3. Crear el usuario dueño

En Authentication → Users:

- Crear usuario con el email real del dueño.
- Marcar el email como confirmado.
- Copiar el UUID.
- Reemplazar `USER_UUID` en `supabase/seed/create_owner_profile.sql`.
- Ejecutar ese archivo.

## 4. Netlify

Configurar estas variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

No usar la service role key en el frontend.

## 5. Verificación

- Abrir el sitio de pruebas.
- Iniciar sesión.
- Confirmar nombre y rol en el menú.
- Abrir una caja desde SQL o desde el próximo módulo.
- Probar una venta.
- Verificar venta, sale_items, inventory_movements, cash_movements y audit_log.

## Importante

La función `create_sale_transaction` ejecuta la venta completa dentro de una sola transacción PostgreSQL.
Si falla stock, caja o permisos, no guarda ninguna parte de la operación.
