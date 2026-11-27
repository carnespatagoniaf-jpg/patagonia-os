# Revisión de la migración 223 (perfiles de etiqueta de las balanzas ya registradas)

27/11/2026 · Revisada contra los datos reales de producción, **solo leyendo** (nada se aplicó en producción).

## Qué modifica

| Toca | No toca |
|---|---|
| `scale_profiles.label_spec`: columna nueva de la 222. Solo en balanzas que **todavía no** tienen perfil. | Formato de la sucursal (`branch_scale_configs`) |
| `scale_label_prefixes`: tabla nueva de la 222 | Productos, precios y PLU |
| | Catálogos y vínculos Systel |
| | Ventas, stock, papeles cobrados |
| | Balanzas físicas (no se manda nada) |

**Sin el interruptor `balanzas_v2` la web no lee estos datos**, así que aplicarla no cambia nada de lo que ve ningún cliente. Hoy nadie lo tiene prendido en producción.

## Qué haría con cada balanza real

Son 34 registros en 22 empresas, al 27/11.

| Origen del perfil | Balanzas |
|---|---|
| Lista de Carplat (Report, "21" + peso) | Carplat (1) |
| Lista de El Abastero (Report, 1-6-5 en pesos) | El Abastero: "Kretz Report" y "Kretz Report 2" |
| Lista de El Abastero (Aura, inicio 22) | El Abastero: "Kretz Aura" (está registrada) |
| Lista de Oliem (Report, 2-5-5 con peso) | Oliem: "Kretz Report" y "Kretz Report 2" |
| Formato de la sucursal | Angus, Buen Cerdo, Carnes Ledesma, Carnes Patagonia (Haedo), Carnes premium ×3, Jp24 premium ×2, El Dorado, El SHOPPING de la carne, Los gringos ×4, M2, mercadito isabel, Pollo Pampa, Pollo y mar, Tienda de carnes |
| Formato de fábrica (la sucursal no tiene uno guardado) | Expo Carnes ×2, Giuseppe, GRANJAVIER, La cosa es con carne, Mercado de la Cruz ×2, Quesar |

## Inicios reservados

En cada local, la balanza más vieja reserva sus inicios. Una balanza que chocaría con otra **no reserva nada**: igual se lee con su perfil, y si hay ambigüedad se pregunta. Cuando se la conecte con `balanzas_v2`, recibe un inicio propio.

Locales donde va a haber balanzas sin inicio reservado:
- El Abastero: la "Report 2", que es un registro repetido.
- Oliem: la segunda Report.
- Jp24 premium: la "Aura 2".
- Carnes premium (2), Los gringos (3), Expo Carnes (1) y Mercado de la Cruz (1): son los registros repetidos de la misma Systel, que se unen con la 225.

## Riesgos encontrados y cómo quedan

1. **Systel con un formato de sucursal viejo** (Carnes premium y mercadito isabel tienen "1-5-6 con importe"): la 223 arma la parte de lectura del perfil Systel con ese formato.
   - Con `balanzas_v2` y un local solo-Systel, decide la lectura de la propia Systel (catálogo y formato de la balanza). El perfil solo se usa como respaldo cuando la Systel no reconoce la etiqueta, que es **lo mismo que hace hoy** el formato de la sucursal (la prueba de equivalencia lo confirma).
   - **Regla para prender `balanzas_v2` en un cliente Systel:** primero, que conecte la balanza desde Mis balanzas para que su perfil se rearme con el formato real.
2. **El Abastero:** la Aura con inicio 22 sí está registrada, así que la advertencia de la migración no aplica.
3. **Registros repetidos:** unirlos con la 225 (Mis balanzas → "Unir") **antes** de prender `balanzas_v2` en esos clientes.
4. **Publicación automática:** la 223 no tiene `update`/`delete` sueltos (están dentro de una función), así que el resguardo `PROTEGER_DATOS` del pipeline no la frena. Por eso se aplica solo con el OK explícito del dueño, por `supabase.yml`, después de staging.

## Vuelta atrás

`223_scale_label_spec_data.rollback.sql`:
- Borra solo lo cargado por la 223 (origen "223:…") y sus inicios.
- No toca perfiles guardados después.
- Antes hay que apagar `balanzas_v2` donde esté prendido.
- Probada en staging: aplicar → volver atrás deja las funciones y columnas idénticas.

## Staging

Aplicada el 27/11. Cargó 1 perfil (el de la única balanza registrada) y sus pruebas pasan.
