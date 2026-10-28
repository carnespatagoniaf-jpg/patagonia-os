#!/usr/bin/env bash
# Migraciones pendientes de una base de Supabase (staging o producción).
#
#   bash scripts/ci/apply-migrations.sh revisar   -> solo LISTA lo que falta (no cambia nada)
#   bash scripts/ci/apply-migrations.sh aplicar   -> aplica lo que falta, una por una, cada una en su transacción
#
# La conexión viene en DATABASE_URL (secreto; nunca se imprime).
# Reglas para no romper una base en uso:
#   * Solo mira de la 099 en adelante (desde ahí cada migración se anota en public.schema_migrations).
#   * Pendiente = archivo cuya versión (nombre sin .sql) no está anotada.
#   * Si falta una migración MÁS VIEJA que la última aplicada (un hueco), se frena: eso se revisa a mano.
#   * Si una falla, se deshace esa y se frena (las anteriores ya quedaron aplicadas y anotadas).
set -euo pipefail
set +x

MODE="${1:-revisar}"
case "$MODE" in revisar|aplicar) ;; *) echo "Uso: $0 revisar|aplicar" >&2; exit 2 ;; esac
if [ -z "${DATABASE_URL:-}" ]; then echo "Falta DATABASE_URL" >&2; exit 2; fi

cd "$(dirname "$0")/../.."

q() { psql "$DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

applied="$(q "select version from public.schema_migrations order by version")"
last="$(printf '%s\n' "$applied" | sort | tail -1)"
last_num="${last%%_*}"
echo "Última migración anotada en la base: ${last:-ninguna}"

pending=()
gaps=()
for f in $(ls supabase/migrations/[0-9]*.sql | grep -v '\.rollback\.sql$' | sort); do
  version="$(basename "$f" .sql)"
  num="${version%%_*}"
  [ "$((10#$num))" -lt 99 ] && continue
  if ! printf '%s\n' "$applied" | grep -qxF "$version"; then
    if [ -n "$last_num" ] && [ "$((10#$num))" -le "$((10#$last_num))" ]; then
      gaps+=("$version")
    else
      pending+=("$f")
    fi
  fi
done

if [ "${#gaps[@]}" -gt 0 ]; then
  echo "Hay migraciones más viejas que la última aplicada y que la base no tiene:"
  printf '  - %s\n' "${gaps[@]}"
  echo "No se aplica nada automáticamente: hay que revisarlas a mano (puede que se hayan aplicado con otro nombre)."
  exit 1
fi

if [ "${#pending[@]}" -eq 0 ]; then
  echo "La base está al día: no falta ninguna migración."
  exit 0
fi

echo "Faltan ${#pending[@]} migraciones:"
for f in "${pending[@]}"; do echo "  - $(basename "$f")"; done

# Protección de datos (publicación automática, PROTEGER_DATOS=1): una migración que a nivel
# de archivo (fuera de funciones, que van indentadas) borra o cambia filas o tablas no se
# aplica sola. Crear tablas/columnas/funciones/vistas sí. Se mira solo el código, no los comentarios.
if [ "${PROTEGER_DATOS:-0}" = "1" ]; then
  risky=()
  for f in "${pending[@]}"; do
    if grep -nEi '^(drop[[:space:]]+(table|schema|column)|truncate|delete[[:space:]]+from|update[[:space:]]+[a-z_."]+[[:space:]]+set|alter[[:space:]]+table[^;]*drop[[:space:]]+column)' "$f" > /dev/null; then
      risky+=("$(basename "$f")")
    fi
  done
  if [ "${#risky[@]}" -gt 0 ]; then
    echo "Estas migraciones borran o cambian datos y NO se aplican solas (hay que revisarlas antes):"
    printf '  - %s\n' "${risky[@]}"
    exit 3
  fi
fi

if [ "$MODE" = "revisar" ]; then
  echo "(Solo revisión: no se cambió nada.)"
  exit 0
fi

for f in "${pending[@]}"; do
  version="$(basename "$f" .sql)"
  echo "Aplicando $version…"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" > /dev/null
  if ! q "select 1 from public.schema_migrations where version = '$version'" | grep -q 1; then
    echo "La migración $version corrió pero no se anotó en schema_migrations: se frena para revisar." >&2
    exit 1
  fi
  echo "  ok"
done
echo "Listo."
