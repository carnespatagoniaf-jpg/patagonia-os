# Patagonia OS 3.1

Repositorio definitivo del ERP para Carnes Patagonia.

## Estructura

- `apps/web`: aplicación React + TypeScript.
- `apps/api`: API Node.js preparada para reglas sensibles.
- `packages/domain`: reglas del negocio y tipos compartidos.
- `supabase`: esquema y migraciones PostgreSQL.
- `docs`: arquitectura, despliegue y manual técnico.
- `tests`: casos críticos de aceptación.

## Arranque local

1. Instalar Node.js 20.
2. Copiar `.env.example` como `.env`.
3. Ejecutar:

```bash
npm install
npm run dev
```

## Credenciales

Nunca guardar claves privadas en GitHub.

- `VITE_SUPABASE_ANON_KEY` puede usarse en el navegador con RLS habilitado.
- `SUPABASE_SERVICE_ROLE_KEY` solo puede existir en el servidor.

## Estado de esta entrega

La base profesional está creada e incluye:

- Layout y navegación.
- Dashboard funcional con datos de demostración aislados.
- Punto de venta inicial.
- Carrito, medios de pago y validaciones.
- Cliente Supabase preparado.
- API de salud y estructura para ventas.
- Dominio compartido.
- Primera migración multiempresa/multisucursal.
- Pruebas de reglas básicas.
- Configuración de Netlify.

No reemplazar todavía la versión estable hasta configurar Supabase y ejecutar pruebas.


## V3.1

- Login real con Supabase Auth.
- Sesión persistente.
- Perfil, empresa, sucursal y rol.
- Permisos base por rol.
- Vista de productos con stock por sucursal.
- Función SQL transaccional para ventas.
- Seguridad RLS ampliada.
- Guía de configuración completa.
