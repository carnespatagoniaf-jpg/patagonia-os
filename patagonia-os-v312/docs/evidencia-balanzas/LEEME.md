# Evidencia: venta con balanza "artículos + TOTAL" (14/10/2026)

Todo corrió contra **staging** (loquhcwsvsbqpinefxcc), en la empresa aislada "PRUEBA Balanzas (staging)". Producción no tiene nada de esto (ver archivo 5).

| Archivo | Qué prueba | Cómo repetirlo |
|---|---|---|
| `1-pruebas-logica.txt` | 25 pruebas de la lógica, incluidos los 945 tickets reales escaneados como el cajero | `npm test -w @patagonia/web` |
| `2-servidor-945-tickets.txt` | Los 945 tickets reales cobrados por la función real del servidor: plata y stock exactos, reintentos, dos cajas, ventana de repetidos, anulación, 7 rechazos y aislamiento entre empresas | `npx tsx ../../tests/e2e/balanzas-staging-945.mts` (desde `apps/web`) |
| `3-pantalla-mostrador.txt` + capturas | Pantalla real de Stock y Mostrador en Chrome: 23 de 23 comprobaciones | `npx tsx ../../tests/e2e/ui-balanza-articulos-total.mts` (con el servidor de staging en el puerto 5195) |
| `4-todas-las-pruebas.txt` | Las 566 pruebas automáticas de la web (incluye Kretz Aura/Report y Systel) | `npm test -w @patagonia/web` |
| `5-aislamiento-kretz-y-otros-clientes.txt` | Una empresa sin la balanza nueva lee sus etiquetas igual que antes; archivos de Kretz y de lectura de etiquetas sin cambios; la migración no modifica nada existente; producción no tiene nada | idem |

Consultas para verificarlo en staging vos mismo (SQL):
- `select count(*) from pos_scale_paper_claims c join pos_sales s on s.id = c.sale_id where s.company_id = '8299b743-beb0-48a5-bf9d-5e8300d5c67b';`
- `select action, created_at from audit_log where company_id = '8299b743-beb0-48a5-bf9d-5e8300d5c67b' and action like 'scale%' order by created_at desc limit 10;`
