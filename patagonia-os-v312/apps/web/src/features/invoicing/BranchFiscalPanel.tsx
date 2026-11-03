import { useCallback, useEffect, useState } from "react";
import { listTransferBranches, type TransferBranch } from "../transfers/transfers-service";
import { checkBranchArcaConnection, listBranchFiscal, saveBranchFiscal, type BranchFiscal } from "./invoicing-service";

// Facturas → "Datos de cada local" (plan Empresa, migración 191). El CUIT y el certificado son uno solo; cada local
// puede facturar con su punto de venta y su domicilio. Vacío = usa los datos generales, como siempre.

interface Row {
  pointOfSale: string;
  address: string;
}

export function BranchFiscalPanel({ generalPointOfSale }: { generalPointOfSale: number | null }) {
  const [branches, setBranches] = useState<TransferBranch[]>([]);
  const [saved, setSaved] = useState<Map<string, BranchFiscal>>(new Map());
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    const [b, f] = await Promise.all([listTransferBranches(), listBranchFiscal()]);
    const byBranch = new Map(f.map((x) => [x.branchId, x]));
    setBranches(b);
    setSaved(byBranch);
    setRows(Object.fromEntries(b.map((br) => [br.id, { pointOfSale: byBranch.get(br.id) ? String(byBranch.get(br.id)!.pointOfSale) : "", address: byBranch.get(br.id)?.address ?? "" }])));
  }, []);

  useEffect(() => {
    void reload().catch(() => setMessage("No se pudieron cargar los locales."));
  }, [reload]);

  if (branches.length < 2) return null;

  async function save(branchId: string, name: string) {
    const row = rows[branchId];
    const pv = row.pointOfSale.trim() === "" ? null : Number(row.pointOfSale);
    setMessage("");
    if (pv !== null && (!Number.isInteger(pv) || pv < 1 || pv > 99998)) return setMessage(`${name}: el punto de venta es un número de 1 a 99998.`);
    if (pv !== null && !row.address.trim()) return setMessage(`${name}: poné el domicilio del local, va impreso en la factura.`);
    setBusy(branchId);
    try {
      await saveBranchFiscal(branchId, pv, row.address);
      if (pv === null) {
        setMessage(`${name} vuelve a facturar con el punto de venta y el domicilio generales.`);
      } else {
        const r = await checkBranchArcaConnection(branchId);
        setMessage(`${name}: ${r.message}`);
      }
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-title">
        <h2>Datos de cada local</h2>
        <span>plan Empresa</span>
      </div>
      <p className="muted" style={{ marginTop: -6 }}>
        El CUIT y el certificado son uno solo para toda la empresa. Cada local puede facturar con su punto de venta y su domicilio (los dos van impresos). Vacío = usa los generales
        {generalPointOfSale ? ` (punto de venta ${generalPointOfSale})` : ""}. Cada punto de venta se da de alta antes en ARCA como "RECE para aplicativo y web services".
      </p>
      {message && <div className="message">{message}</div>}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Local</th>
              <th>Punto de venta</th>
              <th>Domicilio del local</th>
              <th>Estado en ARCA</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {branches.map((b) => {
              const s = saved.get(b.id);
              const row = rows[b.id] ?? { pointOfSale: "", address: "" };
              const dirty = row.pointOfSale !== (s ? String(s.pointOfSale) : "") || row.address !== (s?.address ?? "");
              return (
                <tr key={b.id}>
                  <td><b>{b.name}</b></td>
                  <td>
                    <input
                      className="num"
                      type="text"
                      inputMode="numeric"
                      style={{ width: 90 }}
                      value={row.pointOfSale}
                      onChange={(e) => setRows((r) => ({ ...r, [b.id]: { ...row, pointOfSale: e.target.value.replace(/\D/g, "") } }))}
                    />
                  </td>
                  <td>
                    <input value={row.address} maxLength={200} style={{ width: "100%", minWidth: 240 }} placeholder="Calle y número, localidad" onChange={(e) => setRows((r) => ({ ...r, [b.id]: { ...row, address: e.target.value } }))} />
                  </td>
                  <td>
                    {!s ? (
                      <span className="muted">usa el general</span>
                    ) : s.lastCheckOk === null ? (
                      <span className="badge">sin probar</span>
                    ) : s.lastCheckOk ? (
                      <span className="badge ok">Probado ✓</span>
                    ) : (
                      <span className="badge danger" title={s.lastCheckMessage ?? ""}>ARCA no lo acepta</span>
                    )}
                    {s && s.lastCheckOk === false && s.lastCheckMessage && <span className="cell-sub" style={{ whiteSpace: "normal" }}>{s.lastCheckMessage}</span>}
                  </td>
                  <td>
                    <div className="row-actions">
                      {dirty ? (
                        <button disabled={busy !== null} onClick={() => void save(b.id, b.name)}>
                          {busy === b.id ? "Guardando…" : row.pointOfSale ? "Guardar y probar" : "Guardar"}
                        </button>
                      ) : (
                        s && (
                          <button className="secondary" disabled={busy !== null} onClick={() => void save(b.id, b.name)}>
                            {busy === b.id ? "Probando…" : "Probar con ARCA"}
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
