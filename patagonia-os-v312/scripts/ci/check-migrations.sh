#!/usr/bin/env bash
# Corre TODAS las migraciones (001 en adelante) en un Postgres VACÍO y después
# las pruebas SQL de tests/sql. Nunca se conecta a staging ni a producción:
# exige una base local llamada como en PGDATABASE y se niega si el host no es local.
#
# Uso (CI o local):  PGHOST=localhost PGUSER=postgres PGDATABASE=patagonia_ci bash scripts/ci/check-migrations.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

case "${PGHOST:-localhost}" in
  localhost|127.0.0.1|/tmp|/var/run/postgresql) ;;
  *) echo "Se niega: PGHOST=${PGHOST} no es local. Este script es solo para una base de prueba vacía." >&2; exit 1 ;;
esac
DB="${PGDATABASE:-patagonia_ci}"
export PGDATABASE="$DB"

# Base nueva cada vez (es una base de prueba local).
psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\"" -c "create database \"$DB\""
psql -X -q -v ON_ERROR_STOP=1 -c "alter database \"$DB\" set search_path = public, extensions"
psql -X -q -v ON_ERROR_STOP=1 -f scripts/ci/supabase-stub.sql

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
cp supabase/migrations/[0-9]*.sql "$WORK/"
rm -f "${WORK:?}"/*.rollback.sql

# 103 en el repo tiene "as $" / "$;" en confirm_bank_matches (en producción la
# función existe: se arregló al aplicarla). Se corrige solo en la copia de prueba.
sed -i 's/^as \$$/as $$/; s/^\$;$/$$;/' "$WORK/103_bank_reconciliation.sql"

# Números repetidos = dos migraciones distintas con el mismo número: no se aplican en orden seguro.
# 145 es histórico (145_customer_charge_adjustment y 145_period_result_report, las dos ya
# aplicadas en producción en orden alfabético): no se renombra, solo se acepta esa.
KNOWN_DUPS="145"
dups="$(ls "$WORK" | cut -d_ -f1 | sort | uniq -d | grep -vxF -f <(tr ' ' '\n' <<<"$KNOWN_DUPS") || true)"
if [ -n "$dups" ]; then
  echo "Hay números de migración repetidos: $dups" >&2
  exit 1
fi

count=0
for f in $(ls "$WORK" | sort); do
  if ! out="$(psql -X -q -v ON_ERROR_STOP=1 -f "$WORK/$f" 2>&1 >/dev/null)"; then
    echo "FALLÓ la migración $f:" >&2
    echo "$out" | grep -v NOTICE >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "Migraciones aplicadas desde cero: $count"

for t in $(ls tests/sql/*.sql 2>/dev/null | sort); do
  if ! out="$(psql -X -q -v ON_ERROR_STOP=1 -f "$t" 2>&1)"; then
    echo "FALLÓ la prueba $t:" >&2
    echo "$out" | grep -v "^NOTICE" >&2
    exit 1
  fi
  echo "ok $t"
done
