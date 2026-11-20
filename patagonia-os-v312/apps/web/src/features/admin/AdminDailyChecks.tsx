import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { listDailyChecks, type DailyCheck } from "./admin-service";
import { dailyCheckIssues } from "./daily-checks";
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from "./ui/components";
import { DataTable, type Column } from "./ui/DataTable";

type Row = { c: DailyCheck; issues: string[] };

const COLUMNS: Column<Row>[] = [
  {
    key: "name",
    header: "Cliente",
    main: true,
    render: ({ c }) => (
      <span className="pa-row" style={{ gap: 6 }}>
        <strong>{c.name}</strong>
        {c.inTrial && <Badge tone="info" dot={false}>prueba</Badge>}
      </span>
    ),
    sortValue: ({ c }) => c.name,
    csvValue: ({ c }) => c.name
  },
  {
    key: "issues",
    header: "Qué pasa",
    render: ({ issues }) => <span>{issues.join(" · ")}</span>,
    sortValue: ({ issues }) => issues.length,
    firstDir: "desc",
    csvValue: ({ issues }) => issues.join(" · ")
  }
];

/**
 * "Para revisar hoy" (auditoría 29/10/2026): los clientes activos con algo para mirar, el que más problemas tiene
 * primero. Solo lee (migración 180). Si no carga, lo dice y deja reintentar (antes desaparecía sin avisar).
 */
export function AdminDailyChecks() {
  const [rows, setRows] = useState<DailyCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listDailyChecks()
      .then((r) => !cancelled && setRows(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "No se pudo cargar."));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setRows(null);
    setAttempt((n) => n + 1);
  }, []);

  if (error) {
    return (
      <Alert tone="warn" title="No se pudo revisar a los clientes" action={<Button variant="secondary" size="sm" onClick={retry}>Reintentar</Button>}>
        {error}
      </Alert>
    );
  }

  const withIssues: Row[] = (rows ?? []).map((c) => ({ c, issues: dailyCheckIssues(c) })).filter((x) => x.issues.length > 0);

  return (
    <Card
      title="Para revisar hoy"
      subtitle={rows === null ? "Revisando los clientes…" : withIssues.length === 0 ? "Todos los clientes activos están bien." : `${withIssues.length} de ${rows.length} clientes activos tienen algo para mirar`}
    >
      {rows === null ? (
        <Skeleton lines={4} />
      ) : withIssues.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Nada para revisar hoy">Ningún cliente tiene la caja abierta de días, stock negativo ni facturas trabadas.</EmptyState>
      ) : (
        <DataTable rows={withIssues} columns={COLUMNS} rowKey={({ c }) => c.id} defaultSort={{ key: "issues", dir: "desc" }} exportName="para-revisar-hoy" />
      )}
    </Card>
  );
}
