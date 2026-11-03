import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { can } from "../auth/permissions";
import { useActiveBranch } from "../branches/BranchProvider";
import { MinStockTab } from "./MinStockTab";
import { PrepareTab } from "./PrepareTab";
import { ReceiveTab } from "./ReceiveTab";
import { RequestTab } from "./RequestTab";
import { TransitTab } from "./TransitTab";
import type { Transfer } from "./transfer-logic";
import { listTransferBranches, listTransfers, type TransferBranch } from "./transfers-service";

// Mercadería entre locales (Sucursales etapa 2, migración 190, plan Empresa; maqueta aprobada el 02/11/2026).
// Todo se ve desde el local activo (el selector de arriba): qué pide, qué tiene que preparar y qué tiene que
// recibir. El dueño y el administrador además ven lo que está en viaje en toda la cadena, los mínimos de cada
// local y el pase rápido de siempre. El encargado, el cajero y producción lo usan desde su propia pantalla.

export type TransferTab = "pedir" | "preparar" | "viaje" | "recibir" | "historial" | "minimos" | "rapido";

export interface TransfersContext {
  branches: TransferBranch[];
  branchName: (id: string) => string;
  activeBranchId: string;
  /** Dueño/administrador: actúa por cualquier local y ve toda la cadena. */
  admin: boolean;
  /** Ve costos (Tesorería): el cajero no. */
  seesCost: boolean;
  transfers: Transfer[];
  /** Vuelve a leer los envíos y los devuelve. */
  reload: () => Promise<Transfer[]>;
  notify: (text: string) => void;
}

export function Transfers({ admin, quickTransfer }: { admin: boolean; quickTransfer?: ReactNode }) {
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const seesCost = can(profile, "treasury.manage");
  const [branches, setBranches] = useState<TransferBranch[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TransferTab>("pedir");

  const reload = useCallback(async (): Promise<Transfer[]> => {
    try {
      const [b, t] = await Promise.all([listTransferBranches(), listTransfers()]);
      setBranches(b);
      setTransfers(t);
      setError("");
      return t;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los envíos.");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const names = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const branchName = useCallback((id: string) => names.get(id) ?? "Local", [names]);

  const activeBranchId = branchId ?? "";
  const toPrepare = transfers.filter((t) => t.fromBranchId === activeBranchId && (t.status === "pedido" || t.status === "preparando")).length;
  const inTransit = transfers.filter((t) => t.status === "en_viaje" && (admin || t.fromBranchId === activeBranchId || t.toBranchId === activeBranchId)).length;
  const toReceive = transfers.filter((t) => t.toBranchId === activeBranchId && t.status === "en_viaje").length;

  if (!loading && branches.length < 2) {
    return <p className="muted">Para pasar mercadería entre locales hacen falta por lo menos dos locales.</p>;
  }

  const ctx: TransfersContext = { branches, branchName, activeBranchId, admin, seesCost, transfers, reload, notify: setMessage };
  const count = (n: number) => (n > 0 ? <span className="nav-count">{n}</span> : null);
  const segments: Array<[TransferTab, ReactNode]> = [
    ["pedir", "Pedir"],
    ["preparar", <>Pedidos para preparar{count(toPrepare)}</>],
    ["viaje", <>En viaje{count(inTransit)}</>],
    ["recibir", <>Para recibir{count(toReceive)}</>],
    ["historial", "Historial"]
  ];
  if (admin) segments.push(["minimos", "Mínimos por local"]);
  if (admin && quickTransfer) segments.push(["rapido", "Pase rápido"]);

  return (
    <div className="transfers">
      <div className="transfers-top">
        <div className="ws-seg">
          {segments.map(([key, label]) => (
            <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => { setTab(key); setMessage(""); }}>
              {label}
            </button>
          ))}
        </div>
        {admin && tab !== "minimos" && tab !== "rapido" && (
          <p className="muted transfers-as">
            Estás viendo como <b>{branchName(activeBranchId)}</b>. Para actuar por otro local, cambialo arriba.
          </p>
        )}
      </div>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}
      {loading && <p className="muted">Cargando…</p>}

      {!loading && activeBranchId && (
        <>
          {tab === "pedir" && <RequestTab ctx={ctx} onDone={() => setTab("historial")} />}
          {tab === "preparar" && <PrepareTab ctx={ctx} />}
          {tab === "viaje" && <TransitTab ctx={ctx} mode="viaje" />}
          {tab === "recibir" && <ReceiveTab ctx={ctx} />}
          {tab === "historial" && <TransitTab ctx={ctx} mode="historial" />}
          {tab === "minimos" && admin && <MinStockTab ctx={ctx} />}
          {tab === "rapido" && admin && quickTransfer}
        </>
      )}
    </div>
  );
}
