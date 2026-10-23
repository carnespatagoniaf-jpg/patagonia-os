import { useCallback, useEffect, useMemo, useState } from "react";
import { todayIso } from "../shifts/format";
import { arDateLabel, voucherNumberLabel } from "./invoicing-view";
import { caiStatus, lastNumberByPointOfSale, validateCaiForm, type CaiForm, type Remito, type RemitoCai } from "./remito-r";
import { listRemitoCais, listRemitos, saveRemitoCai, setRemitoCaiActive, voidRemito } from "./remito-service";
import { RemitoRPrint } from "./RemitoRPaper";

const STATE_LABEL = { vigente: "Vigente", vencido: "Vencido", agotado: "Sin números", dado_de_baja: "Dado de baja" } as const;
const emptyForm = (): CaiForm => ({ pointOfSale: "", cai: "", caiDue: "", numberFrom: "1", numberTo: "" });

/**
 * Facturas → "Remito R (con CAI)", plan Full (migración 147). El CAI lo saca el
 * contador en ARCA (régimen de autoimpresores); acá se carga y se ven los
 * remitos emitidos desde Clientes.
 */
export function RemitoRPanel({ issuerCondition }: { issuerCondition: string | null }) {
  const [cais, setCais] = useState<RemitoCai[]>([]);
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [form, setForm] = useState<CaiForm>(emptyForm());
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [printing, setPrinting] = useState<Remito | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([listRemitoCais(), listRemitos()]);
      setCais(c);
      setRemitos(r);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudieron cargar los remitos.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const today = todayIso();
  const lastByPos = useMemo(() => lastNumberByPointOfSale(remitos), [remitos]);
  const statuses = cais.map((c) => ({ cai: c, status: caiStatus(c, lastByPos.get(c.pointOfSale) ?? null, today) }));
  const usable = statuses.some((s) => s.status.state === "vigente");

  async function handleSave() {
    const error = validateCaiForm(form, today);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await saveRemitoCai({
        pointOfSale: Number(form.pointOfSale),
        cai: form.cai,
        caiDue: form.caiDue,
        numberFrom: Number(form.numberFrom),
        numberTo: Number(form.numberTo)
      });
      setForm(emptyForm());
      setShowForm(false);
      setMessage("CAI guardado. Ya podés emitir Remitos R desde Clientes.");
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo guardar el CAI.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(c: RemitoCai) {
    if (c.active && !window.confirm("¿Dar de baja este CAI? No se van a emitir más remitos con él.")) return;
    setBusy(true);
    try {
      await setRemitoCaiActive(c.id, !c.active);
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo cambiar el CAI.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid(r: Remito) {
    if (!window.confirm(`¿Anular el remito ${voucherNumberLabel(r.pointOfSale, r.number)}? Queda guardado como anulado y su número no se vuelve a usar.`)) return;
    setBusy(true);
    try {
      await voidRemito(r.id);
      await reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo anular el remito.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-title">
        <h2>Remito R (con CAI)</h2>
        <span className="muted" style={{ fontSize: 12 }}>{usable ? "Listo para emitir" : "Falta cargar un CAI vigente"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        El remito oficial que acompaña la mercadería ("documento no válido como factura"). Tu contador pide en ARCA un <strong>CAI para remitos</strong> como
        autoimpresor (punto de venta, números desde/hasta y vencimiento). Lo cargás acá una vez y después lo emitís desde <strong>Clientes</strong>, en cada venta, con el botón
        "Remito R". El sistema numera en orden, sin saltos ni repetidos.
      </p>

      {issuerCondition === "monotributo" && (
        <p style={{ color: "#8a4b00", fontSize: 13 }}>
          Tu negocio es monotributista: ARCA no permite que un monotributista sea autoimpresor, así que el Remito R no se puede emitir desde el sistema.
          Lo podés pedir a una imprenta (talonario) o facturar la venta, que sí sale desde acá.
        </p>
      )}
      {statuses.length > 0 && (
        <div style={{ overflowX: "auto", marginBottom: 10 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Punto de venta</th>
                <th>CAI</th>
                <th>Números</th>
                <th>Vence</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {statuses.map(({ cai, status }) => (
                <tr key={cai.id}>
                  <td>{String(cai.pointOfSale).padStart(5, "0")}</td>
                  <td>{cai.cai}</td>
                  <td>
                    {cai.numberFrom} a {cai.numberTo}
                    <div className="muted" style={{ fontSize: 12 }}>usados {status.used} · quedan {status.remaining}</div>
                  </td>
                  <td>{arDateLabel(cai.caiDue)}</td>
                  <td>
                    <strong style={{ color: status.state === "vigente" ? "#176329" : "#8b1e1e" }}>{STATE_LABEL[status.state]}</strong>
                    {status.warn && (
                      <div style={{ fontSize: 12, color: "#8a4b00" }}>
                        {status.daysLeft <= 15 ? `vence en ${status.daysLeft} días` : `quedan ${status.remaining} números`}: pedí el próximo CAI
                      </div>
                    )}
                  </td>
                  <td>
                    <button className="secondary" disabled={busy} onClick={() => void handleToggle(cai)}>{cai.active ? "Dar de baja" : "Reactivar"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!showForm ? (
        <button className={usable ? "secondary" : undefined} onClick={() => setShowForm(true)}>+ Cargar CAI</button>
      ) : (
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <label>
            Punto de venta de remitos
            <input inputMode="numeric" value={form.pointOfSale} onChange={(e) => setForm({ ...form, pointOfSale: e.target.value.replace(/\D/g, "") })} placeholder="Ej.: 3" />
          </label>
          <label>
            CAI (14 números)
            <input inputMode="numeric" value={form.cai} onChange={(e) => setForm({ ...form, cai: e.target.value })} placeholder="Ej.: 76123456789012" />
          </label>
          <label>
            Fecha de vencimiento del CAI
            <input type="date" value={form.caiDue} onChange={(e) => setForm({ ...form, caiDue: e.target.value })} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1 }}>
              Desde el número
              <input inputMode="numeric" value={form.numberFrom} onChange={(e) => setForm({ ...form, numberFrom: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label style={{ flex: 1 }}>
              Hasta el número
              <input inputMode="numeric" value={form.numberTo} onChange={(e) => setForm({ ...form, numberTo: e.target.value.replace(/\D/g, "") })} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy} onClick={() => void handleSave()}>Guardar CAI</button>
            <button className="secondary" disabled={busy} onClick={() => setShowForm(false)}>Cancelar</button>
          </div>
        </div>
      )}
      {message && <p style={{ marginBottom: 0 }}>{message}</p>}

      {remitos.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Remitos emitidos ({remitos.length})</summary>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {remitos.map((r) => (
                  <tr key={r.id}>
                    <td>{voucherNumberLabel(r.pointOfSale, r.number)}</td>
                    <td>{arDateLabel(r.issuedOn)}</td>
                    <td>{r.receiver.name}</td>
                    <td>{r.status === "anulado" ? <span style={{ color: "#8b1e1e" }}>Anulado</span> : "Emitido"}</td>
                    <td>
                      <button className="secondary" onClick={() => setPrinting(r)}>Imprimir</button>{" "}
                      {r.status === "emitido" && <button className="secondary" disabled={busy} onClick={() => void handleVoid(r)}>Anular</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {printing && <RemitoRPrint remito={printing} onDone={() => setPrinting(null)} />}
    </section>
  );
}
