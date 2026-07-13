# Arquitectura

## Principios

1. Multiempresa y multisucursal desde el inicio.
2. El stock surge de movimientos; no se edita como un número aislado.
3. Las operaciones sensibles deben ejecutarse en transacciones.
4. Las anulaciones compensan movimientos y dejan auditoría.
5. Las claves privadas viven solamente en servidor.
6. La interfaz no conoce reglas críticas de seguridad.

## Flujo de una venta definitiva

1. Autenticar usuario.
2. Verificar permisos y sucursal.
3. Verificar caja abierta.
4. Bloquear y validar stock.
5. Crear venta e ítems.
6. Generar salidas de inventario.
7. Generar entrada de caja.
8. Registrar auditoría.
9. Confirmar toda la transacción o revertir completa.

## Evolución

- V3.0: repositorio definitivo.
- V3.1: Supabase real y autenticación.
- V3.2: venta transaccional.
- V3.3: compras y proveedores.
- V3.4: producción y empleados.
- V3.5: migración de Excel y piloto.
