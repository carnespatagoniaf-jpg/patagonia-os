# 3. Volver al sistema anterior

Todo lo nuevo se puede apagar sin perder datos. Ordenado de lo más rápido a lo más completo.

## En la PC de pruebas

| Qué | Cómo | Efecto |
|---|---|---|
| Dejar de usar Scale Connect en una balanza | Mis balanzas: enviar por cable como antes (Web Serial). Scale Connect solo se usa si la balanza está asignada a una PC en línea | Sigue funcionando el camino de siempre |
| Parar el servicio | Servicios → Patagonia Scale Connect → Detener | Libera los puertos (iTegra y Qendra vuelven a poder usarlos) |
| Desinstalar | Configuración → Aplicaciones → **Patagonia Scale Connect** → Desinstalar. Pregunta si borrar los datos (por omisión no) | Se va el servicio. La configuración de las balanzas queda en Patagonia |
| Desvincular la PC | Mis balanzas → Computadoras con Scale Connect → **Desvincular** | La credencial de esa PC deja de servir al instante |

## En Patagonia (por empresa)

- **Apagar `balanzas_v2`:** Panel de plataforma → la empresa → Pantallas a pedido → destildar "Balanzas v2".
  - Mostrador vuelve **en el momento** a leer las etiquetas como hoy, con el formato del local.
  - No hace falta tocar nada más: ese formato nunca se borra.
- **Una balanza que recibió un inicio nuevo (22-29)** sigue imprimiendo con ese inicio hasta que se le mande otro.
  - Con `balanzas_v2` apagado, Mostrador la lee con el formato del local, que puede no coincidir.
  - **Orden seguro:** primero se le devuelve a esa balanza su formato anterior (lo hago yo, queda guardado en su historial de perfiles), se imprime una etiqueta de prueba, y **recién después** se apaga `balanzas_v2`.
  - En las pruebas del demo no importa: se limpia todo al final.

## En la base (solo staging, y en producción solo con tu OK)

- Cada migración nueva (220 a 228) tiene su archivo `.rollback.sql`. En staging se ensayó aplicar y volver atrás, y las funciones quedaron idénticas.
- Respaldos de staging antes de aplicar: `Documentos\patagonia-respaldos\staging-2026-11-27-*`.
- El orden para volver atrás es el inverso: 228 → 220.
- **La 223 se revierte sola** (borra solo lo que cargó, con origen "223:…"). Antes hay que apagar `balanzas_v2` donde esté prendido.

## Limpiar el demo después de las pruebas

Avisame y lo hago yo. Hay que:
- borrar las balanzas registradas en Barrio Norte, sus trabajos y sus inicios;
- borrar la PC vinculada;
- apagar `balanzas_v2` en el demo.

Los videos tutoriales usan el local Centro, que no se toca en estas pruebas.
