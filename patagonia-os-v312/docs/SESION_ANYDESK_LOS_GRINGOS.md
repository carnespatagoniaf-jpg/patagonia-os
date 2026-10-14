# Sesión única por AnyDesk: Los gringos, de la balanza a la primera venta real

**Entorno privado (listo, 14/10):**
- Dirección: `https://6acfd7120bea23faa0df81f4--sistemapatagonia.netlify.app`.
- Es un borrador de Netlify con la herramienta de escritura, del commit `83e1b34`.
- Producción no cambió: sigue `index-B9u41B3l.js`, sin la herramienta.
- Usa la base de producción. Sin la migración 119, todo lo nuevo de Mostrador queda apagado solo.

## Antes del día (nosotros)
1. Autorizaciones (ver al final).
2. Mensaje al cliente: dejar la PC prendida con AnyDesk; la balanza prendida, por USB y con papel; el lector conectado; el local sin clientes ~40 min; Mostrador de Patagonia cerrado en otras pestañas.
3. Si la migración 119 está autorizada, se aplica en producción antes de la sesión (solo agrega; se ensayó su reversión).

## La sesión (lo hacemos nosotros; ✋ = una persona en la balanza)

| # | Paso | Tiempo |
|---|---|---|
| 1 | Abrir el entorno privado. El cliente escribe su contraseña (es otra dirección). Stock → Balanza. Elegir el puerto "FT232R (COM3)" | 3 min |
| 2 | Diagnóstico completo + Respaldar productos (solo lectura). Si no sale "completo", se corta acá | 5 min |
| 3 | **1. Probar en números libres:** crea 7999 (peso) y 7998 (unidad) a $1. No toca nada del cliente | 2 min |
| 4 | ✋ Un ticket con 7999 (algo arriba de la balanza) y 7998 × 2. Lo escaneamos en "Probar un código impreso": producto, kg, unidades y TOTAL | 4 min |
| 5 | ✋ Total del 7999 en el menú de la balanza → **1b. Reescribir** → ✋ total otra vez: ¿cambió? | 4 min |
| 6 | **Decisión:** si no cambió (o el cliente acepta que se reinicien los totales internos de la balanza) → **3. Todos los productos** (≈5 min, frena ante cualquier diferencia). Si no, se termina acá | 5 min |
| 7 | "Guardar en Patagonia los productos leídos" → "Vincular los que coinciden" → las 3 sugerencias (96→102, 98→78, 100→80) → encender | 3 min |
| 8 | ✋ **Primera venta real:** pesan un producto común, imprimen, y en Mostrador (entorno privado) se escanea cada código + el TOTAL, y se cobra | 3 min |
| 9 | Nosotros: la venta, el papel registrado y el stock bajado una vez (también si es una presentación: cajón = 15 kg) | 2 min |

La persona en la balanza interviene ~10 minutos: pasos 4, 5 y 8.

**Si algo falla:**
- **Pasos 2 a 5:** nada del cliente cambió.
- **Paso 6:** frena solo, y "Restaurar desde el respaldo" vuelve los productos atrás.
- **Pasos 7 a 9:** el interruptor (Apagar) deja Mostrador como antes.
- **Una venta mal:** se anula y devuelve el stock.

## Decisiones comerciales que solo puede tomar el cliente
1. **30 MOLIDA x1, 64 PAN RALLADO X1X5 y 65 PAN RALLADO 20 KG:** en la balanza se venden por unidad y en Patagonia por kg, y están en presentaciones que armó él (31 = 5 × 30; 64 usa el stock del 65). ¿Por unidad o por kg?
2. **97 BOCADITOS CAJA, 99 ARABES X 5, 101 PASCUALINAS X5, 102 COMBO 1 y 103 COMBO 2 de la balanza:** ¿son 103, 79, 81, 82 y 83 de Patagonia?
3. **Si acepta que la escritura reinicie los totales internos de la balanza** (solo si el paso 5 muestra que pasa).
4. **El stock inicial que tiene hoy:** todo está en 0. Sin conteo, el stock arranca en negativo hasta que cuente.
