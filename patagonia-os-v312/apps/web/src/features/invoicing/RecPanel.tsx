import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveBranch } from "../branches/BranchProvider";
import { todayIso } from "../shifts/format";
import { arDateLabel, formatCuit } from "./invoicing-view";
import {
  MOVIMIENTO_LABEL,
  STATUS_LABEL,
  arcaEstadoLabel,
  formToPayload,
  recActions,
  recFormProblems,
  recNumberLabel,
  searchTiposCarne,
  type CodigoDescripcion,
  type RecForm,
  type RecItemForm,
  type RecPoint,
  type RecRemito,
  type RecSettings
} from "./rec-logic";
import {
  checkRecConnection,
  createRecRemito,
  discardRecRemito,
  getRecSettings,
  listRecCustomers,
  listRecPoints,
  listRecProductCodes,
  listRecProducts,
  listRecRemitos,
  recAction,
  recDomicilios,
  saveRecPoint,
  saveRecSettings,
  type RecCustomerOption,
  type RecProductOption
} from "./rec-service";
import { RecPrint } from "./RecPaper";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const emptyItem = (): RecItemForm => ({ key: newKey(), productId: "", productName: "", codTipoProd: "", tropa: "", kilos: "", unidades: "" });
const emptyForm = (point: string): RecForm => ({
  pointOfEmission: point,
  tipoMovimiento: "ENV",
  destino: "cliente",
  destinationBranchId: "",
  customerId: "",
  cuitReceptor: "",
  receptorName: "",
  categoriaReceptor: "",
  codDomDestino: "",
  destinoDesc: "",
  motivo: "",
  cuitTransportista: "",
  transportistaName: "",
  cuitConductor: "",
  dominioVehiculo: "",
  dominioAcoplado: "",
  fechaInicioViaje: todayIso(),
  distanciaKm: "",
  notes: "",
  items: [emptyItem()]
});

const STATUS_COLOR: Record<string, string> = { emitido: "#176329", rechazado: "#8b1e1e", incierto: "#8a4b00", generado: "#8a4b00", anulado: "#555" };

/**
 * Facturas → "Remito electrónico cárnico (ARCA)", plan Full (migración 202).
 * Para carne bovina y porcina (tablas de ARCA). Lo demás sigue con el Remito R con CAI.
 */
export function RecPanel({ canSetup, cuitEmisor }: { canSetup: boolean; cuitEmisor: string | null }) {
  const { branches } = useActiveBranch();
  const [settings, setSettings] = useState<RecSettings | null | undefined>(undefined);
  const [points, setPoints] = useState<RecPoint[]>([]);
  const [remitos, setRemitos] = useState<RecRemito[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [newPoint, setNewPoint] = useState({ point: "", branchId: "", label: "" });
  const [creating, setCreating] = useState(false);
  const [printing, setPrinting] = useState<RecRemito | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await getRecSettings();
      setSettings(s);
      if (s === null) return;
      const [p, r] = await Promise.all([listRecPoints(), listRecRemitos()]);
      setPoints(p);
      setRemitos(r);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudieron cargar los remitos.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Sin la migración (tabla inexistente) no se muestra nada.
  if (settings === undefined || settings === null) return null;
  const catalog = settings.catalog;
  const ready = settings.enabled && settings.categoriaEmisor !== null && points.some((p) => p.active);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(`${label}…`);
    try {
      await fn();
      setMessage("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo completar.");
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function handleCheck() {
    setBusy(true);
    setMessage("Probando la conexión con ARCA…");
    try {
      const r = await checkRecConnection();
      setMessage(r.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo probar la conexión.");
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function handleAction(r: RecRemito, action: "send" | "emit" | "refresh" | "void" | "discard") {
    if (action === "void" && !window.confirm("¿Anular este remito en ARCA? Solo se puede porque todavía no se emitió.")) return;
    if (action === "discard" && !window.confirm("¿Tirar este remito? No llegó a emitirse en ARCA.")) return;
    const labels = { send: "Mandando a ARCA", emit: "Emitiendo en ARCA", refresh: "Consultando en ARCA", void: "Anulando en ARCA", discard: "Descartando" };
    await run(labels[action], () => (action === "discard" ? discardRecRemito(r.id) : recAction(action, r.id)));
  }

  const env = catalog.env === "homo" ? " · ambiente de PRUEBA" : "";

  return (
    <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-title">
        <h2>Remito electrónico cárnico (ARCA)</h2>
        <span className="muted" style={{ fontSize: 12 }}>{ready ? `Listo para emitir${env}` : "Falta conectar con ARCA"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Para trasladar <strong>carne bovina y porcina</strong> y sus subproductos (las tablas de ARCA). Cada remito se pide a ARCA en el momento y ARCA devuelve el número, el
        código de autorización, el vencimiento y el QR: no hace falta CAI. Para el resto de la mercadería (pollo, almacén) seguí usando el Remito R con CAI.
      </p>

      {canSetup && (
        <details open={showSetup || !ready} onToggle={(e) => setShowSetup((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Conexión con ARCA</summary>
          <ol style={{ paddingLeft: 18, fontSize: 13 }}>
            <li>
              La factura electrónica tiene que estar conectada (usa el mismo certificado). En tu ARCA, "Administrador de Relaciones de Clave Fiscal", dale al certificado
              (computador fiscal "patagonia") también la relación con el <strong>web service del remito cárnico</strong>.
            </li>
            <li>Cargá el punto de emisión que diste de alta en ARCA para "Remito Electrónico Web Services" y de qué local sale la mercadería.</li>
            <li>Tocá "Probar conexión" y elegí tu categoría de emisor de la lista que devuelve ARCA.</li>
          </ol>
          {points.length > 0 && (
            <table className="data-table no-stack" style={{ marginBottom: 8 }}>
              <thead>
                <tr>
                  <th>Punto de emisión</th>
                  <th>Local</th>
                  <th>Según ARCA</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.id}>
                    <td>{String(p.pointOfEmission).padStart(5, "0")}{p.label ? ` · ${p.label}` : ""}</td>
                    <td>{branches.find((b) => b.id === p.branchId)?.name ?? "-"}</td>
                    <td className="cell-sub">{p.arcaDescription ?? "sin comprobar"}</td>
                    <td>
                      <button className="secondary" disabled={busy} onClick={() => void run("Guardando", () => saveRecPoint(p.pointOfEmission, p.branchId, p.label, !p.active))}>
                        {p.active ? "Dar de baja" : "Reactivar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="form-grid" style={{ maxWidth: 640 }}>
            <label>
              Punto de emisión
              <input inputMode="numeric" value={newPoint.point} placeholder="Ej.: 20" onChange={(e) => setNewPoint({ ...newPoint, point: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label>
              Sale del local
              <select value={newPoint.branchId} onChange={(e) => setNewPoint({ ...newPoint, branchId: e.target.value })}>
                <option value="">(sin local)</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label>
              Nombre (opcional)
              <input value={newPoint.label} placeholder="Ej.: Planta" onChange={(e) => setNewPoint({ ...newPoint, label: e.target.value })} />
            </label>
          </div>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy || !newPoint.point}
              onClick={() =>
                void run("Guardando el punto de emisión", async () => {
                  await saveRecPoint(Number(newPoint.point), newPoint.branchId || null, newPoint.label || null, true);
                  setNewPoint({ point: "", branchId: "", label: "" });
                })
              }
            >
              Guardar punto de emisión
            </button>
            <button disabled={busy} onClick={() => void handleCheck()}>Probar conexión con ARCA</button>
          </div>
          {settings.lastCheckMessage && (
            <p style={{ color: settings.lastCheckOk ? "#176329" : "#8b1e1e", fontSize: 13 }}>
              {settings.lastCheckMessage}
              {settings.lastCheckAt && <span className="muted"> ({new Date(settings.lastCheckAt).toLocaleString("es-AR")})</span>}
            </p>
          )}
          {catalog.categoriasEmisor.length > 0 && (
            <label style={{ display: "block", maxWidth: 520 }}>
              Tu categoría de emisor (según ARCA)
              <select
                value={settings.categoriaEmisor ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const c = catalog.categoriasEmisor.find((x) => x.codigo === e.target.value);
                  void run("Guardando la categoría", () => saveRecSettings(c ? Number(c.codigo) : null, c?.descripcion ?? null));
                }}
              >
                <option value="">Elegí…</option>
                {catalog.categoriasEmisor.map((c) => (
                  <option key={c.codigo} value={c.codigo}>{c.codigo} · {c.descripcion}</option>
                ))}
              </select>
            </label>
          )}
        </details>
      )}

      {ready && !creating && (
        <button disabled={busy} onClick={() => setCreating(true)}>+ Nuevo remito electrónico</button>
      )}
      {creating && cuitEmisor && (
        <RecNewForm
          settings={settings}
          points={points.filter((p) => p.active)}
          cuitEmisor={cuitEmisor}
          onCancel={() => setCreating(false)}
          onDone={async (id, msg) => {
            setCreating(false);
            setMessage(msg);
            await reload();
            setOpen(id);
          }}
        />
      )}
      {message && <p style={{ marginBottom: 0 }}>{message}</p>}

      {remitos.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 14 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Número</th>
                <th>Fecha</th>
                <th>Destino</th>
                <th>Estado</th>
                <th className="hide-sm">Código de autorización</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {remitos.map((r) => (
                <RecRow
                  key={r.id}
                  remito={r}
                  catalog={settings.catalog}
                  busy={busy}
                  canVoid={canSetup}
                  expanded={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)}
                  onAction={(a) => (a === "print" ? setPrinting(r) : void handleAction(r, a === "retry" ? "send" : a))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {printing && <RecPrint remito={printing} onDone={() => setPrinting(null)} />}
    </section>
  );
}

function RecRow({
  remito: r,
  catalog,
  busy,
  canVoid,
  expanded,
  onToggle,
  onAction
}: {
  remito: RecRemito;
  catalog: RecSettings["catalog"];
  busy: boolean;
  canVoid: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAction: (a: ReturnType<typeof recActions>[number]) => void;
}) {
  const label: Record<string, string> = {
    send: "Mandar a ARCA",
    retry: "Reintentar (consulta antes)",
    refresh: "Consultar en ARCA",
    emit: "Emitir",
    void: "Anular",
    discard: "Tirar",
    print: "Imprimir / PDF"
  };
  const actions = recActions(r.status).filter((a) => a !== "void" || canVoid);
  const estadoArca = arcaEstadoLabel(r.arcaEstado, catalog);
  return (
    <>
      <tr className="row-clickable" onClick={onToggle}>
        <td>
          {recNumberLabel(r.pointOfEmission, r.nroRemito)}
          {r.env === "homo" && <span className="badge" style={{ marginLeft: 6 }}>PRUEBA</span>}
        </td>
        <td>{arDateLabel((r.fechaEmision ?? r.createdAt).slice(0, 10))}</td>
        <td>
          {r.tipoReceptor === "EM" ? "Depósito propio" : r.receptorName ?? (r.cuitReceptor ? formatCuit(r.cuitReceptor) : MOVIMIENTO_LABEL[r.tipoMovimiento])}
          <div className="cell-sub">{MOVIMIENTO_LABEL[r.tipoMovimiento]} · {r.items.length} renglón{r.items.length === 1 ? "" : "es"}</div>
        </td>
        <td>
          <strong style={{ color: STATUS_COLOR[r.status] ?? undefined }}>{STATUS_LABEL[r.status]}</strong>
          {estadoArca && <div className="cell-sub">ARCA: {estadoArca}</div>}
        </td>
        <td className="hide-sm">{r.codAutorizacion ?? "-"}</td>
        <td>
          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
            {actions.map((a) => (
              <button key={a} className={a === "send" || a === "print" ? undefined : "secondary"} disabled={busy} onClick={() => onAction(a)}>
                {label[a]}
              </button>
            ))}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="row-editor">
          <td colSpan={6}>
            {r.errorMessage && <p style={{ color: r.status === "emitido" ? undefined : "#8b1e1e", marginTop: 0 }}>{r.errorMessage}</p>}
            <div style={{ fontSize: 13 }}>
              <div>Pedido N° {r.idReq} · Código ARCA {r.codRemito ?? "-"}{r.fechaVencimiento ? ` · vence ${arDateLabel(r.fechaVencimiento)}` : ""}</div>
              <div>
                Transporte: {r.transportistaName ?? ""} CUIT {r.cuitTransportista ? formatCuit(r.cuitTransportista) : "-"} · Patente {r.dominioVehiculo ?? "-"} ·{" "}
                {r.distanciaKm ?? "-"} km · inicio {r.fechaInicioViaje ? arDateLabel(r.fechaInicioViaje) : "-"}
              </div>
              {r.destinoDesc && <div>Domicilio de destino: {r.destinoDesc}</div>}
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {r.items.map((i) => (
                  <li key={i.orden}>
                    {i.codTipoProd} {i.productName ?? ""}{i.tropa ? ` · tropa ${i.tropa}` : ""}{i.kilos !== null ? ` · ${i.kilos} kg` : ""}{i.unidades ? ` · ${i.unidades} u.` : ""}
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function RecNewForm({
  settings,
  points,
  cuitEmisor,
  onCancel,
  onDone
}: {
  settings: RecSettings;
  points: RecPoint[];
  cuitEmisor: string;
  onCancel: () => void;
  onDone: (id: string, message: string) => Promise<void>;
}) {
  const { branches } = useActiveBranch();
  const catalog = settings.catalog;
  const [form, setForm] = useState<RecForm>(() => emptyForm(points.length === 1 ? String(points[0].pointOfEmission) : ""));
  const [customers, setCustomers] = useState<RecCustomerOption[]>([]);
  const [products, setProducts] = useState<RecProductOption[]>([]);
  const [codes, setCodes] = useState<Map<string, string>>(new Map());
  const [domicilios, setDomicilios] = useState<CodigoDescripcion[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  // Uno por formulario: un doble clic o un reintento devuelve el mismo remito.
  const clientId = useRef(newKey());

  useEffect(() => {
    void Promise.all([listRecCustomers(), listRecProducts(), listRecProductCodes()])
      .then(([c, p, k]) => {
        setCustomers(c);
        setProducts(p);
        setCodes(k);
      })
      .catch(() => undefined);
  }, []);

  const set = (patch: Partial<RecForm>) => setForm((f) => ({ ...f, ...patch }));
  const setItem = (key: string, patch: Partial<RecItemForm>) => setForm((f) => ({ ...f, items: f.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) }));
  const today = todayIso();
  const isRep = form.tipoMovimiento === "REP";
  const propio = form.destino === "propio";
  const domiciliosShown = propio ? catalog.domiciliosPropios : domicilios;

  const productOptions = useMemo(() => products.map((p) => ({ ...p, label: `${p.code ? `${p.code} · ` : ""}${p.name}` })), [products]);

  async function buscarDomicilios() {
    const cuit = form.cuitReceptor.replace(/\D/g, "");
    if (cuit.length !== 11) {
      setMessage("Escribí el CUIT del destinatario (11 números).");
      return;
    }
    setBusy(true);
    setMessage("Pidiendo a ARCA los domicilios de ese CUIT…");
    try {
      const r = await recDomicilios(cuit);
      setDomicilios(r.items);
      setMessage(r.items.length === 0 ? "ARCA no devolvió domicilios comerciales: podés usar el domicilio fiscal (0)." : "");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudieron traer los domicilios.");
    } finally {
      setBusy(false);
    }
  }

  async function handleEmit() {
    const p = recFormProblems(form, cuitEmisor, settings.categoriaEmisor, today);
    setProblems(p);
    if (p.length > 0) return;
    setBusy(true);
    setMessage("Guardando el remito…");
    let id: string;
    try {
      id = await createRecRemito(clientId.current, formToPayload(form, cuitEmisor));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo guardar el remito.");
      setBusy(false);
      return;
    }
    setMessage("Pidiendo la autorización a ARCA…");
    try {
      await recAction("send", id);
      await onDone(id, "Listo: mirá el estado del remito en la lista.");
    } catch (e) {
      // El remito quedó guardado: desde la lista se reintenta (consultando antes a ARCA).
      await onDone(id, `${e instanceof Error ? e.message : "ARCA no respondió."} El remito quedó guardado: reintentalo desde la lista.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-box" style={{ marginTop: 8 }}>
      <h3 style={{ marginTop: 0 }}>Nuevo remito electrónico</h3>
      <div className="form-grid">
        <label>
          Sale desde (punto de emisión)
          <select value={form.pointOfEmission} onChange={(e) => set({ pointOfEmission: e.target.value })}>
            <option value="">Elegí…</option>
            {points.map((p) => (
              <option key={p.id} value={p.pointOfEmission}>
                {String(p.pointOfEmission).padStart(5, "0")} · {p.label ?? branches.find((b) => b.id === p.branchId)?.name ?? p.arcaDescription ?? ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Movimiento
          <select
            value={form.tipoMovimiento}
            onChange={(e) => {
              const mov = e.target.value as RecForm["tipoMovimiento"];
              set({ tipoMovimiento: mov, ...(mov === "PLA" ? { destino: "cliente" as const } : {}) });
            }}
          >
            <option value="ENV">Envío a un destinatario</option>
            <option value="PLA">Retiro en planta (lo retira el cliente)</option>
            <option value="REP">Reparto (sin destinatario fijo)</option>
          </select>
        </label>
        {!isRep && (
          <label>
            Va a
            <select value={form.destino} onChange={(e) => set({ destino: e.target.value as RecForm["destino"], codDomDestino: "", destinoDesc: "" })}>
              <option value="cliente">Un cliente</option>
              {form.tipoMovimiento === "ENV" && <option value="propio">Otro local o depósito mío</option>}
            </select>
          </label>
        )}
        <label>
          Motivo del traslado
          <input value={form.motivo} placeholder={propio ? "Ej.: reposición de local" : "Ej.: venta"} onChange={(e) => set({ motivo: e.target.value })} />
        </label>
      </div>

      {!isRep && propio && (
        <div className="form-grid">
          <label>
            Local de destino
            <select value={form.destinationBranchId} onChange={(e) => set({ destinationBranchId: e.target.value })}>
              <option value="">Elegí…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label>
            Domicilio de destino (según ARCA)
            <select
              value={form.codDomDestino}
              onChange={(e) => set({ codDomDestino: e.target.value, destinoDesc: domiciliosShown.find((d) => d.codigo === e.target.value)?.descripcion ?? (e.target.value === "0" ? "Domicilio fiscal" : "") })}
            >
              <option value="">Elegí…</option>
              {domiciliosShown.map((d) => (
                <option key={d.codigo} value={d.codigo}>{d.descripcion}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {!isRep && !propio && (
        <div className="form-grid">
          <label>
            Cliente (opcional)
            <select
              value={form.customerId}
              onChange={(e) => {
                const c = customers.find((x) => x.id === e.target.value);
                set({ customerId: e.target.value, receptorName: c?.name ?? form.receptorName, cuitReceptor: c?.taxId ?? form.cuitReceptor, codDomDestino: "", destinoDesc: "" });
                setDomicilios([]);
              }}
            >
              <option value="">(escribir los datos)</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.taxId ? ` · ${c.taxId}` : ""}</option>
              ))}
            </select>
          </label>
          <label>
            Destinatario
            <input value={form.receptorName} onChange={(e) => set({ receptorName: e.target.value })} />
          </label>
          <label>
            CUIT del destinatario
            <input inputMode="numeric" value={form.cuitReceptor} onChange={(e) => set({ cuitReceptor: e.target.value })} placeholder="11 números" />
          </label>
          <label>
            Categoría del destinatario (según ARCA)
            <select value={form.categoriaReceptor} onChange={(e) => set({ categoriaReceptor: e.target.value })}>
              <option value="">Elegí…</option>
              {catalog.categoriasReceptor.map((c) => (
                <option key={c.codigo} value={c.codigo}>{c.descripcion}</option>
              ))}
            </select>
          </label>
          {form.tipoMovimiento === "ENV" && (
            <label>
              Domicilio de destino
              <div style={{ display: "flex", gap: 6 }}>
                <select
                  style={{ flex: 1, minWidth: 0 }}
                  value={form.codDomDestino}
                  onChange={(e) =>
                    set({ codDomDestino: e.target.value, destinoDesc: e.target.value === "0" ? "Domicilio fiscal del destinatario" : domicilios.find((d) => d.codigo === e.target.value)?.descripcion ?? "" })
                  }
                >
                  <option value="">Elegí…</option>
                  <option value="0">Domicilio fiscal del destinatario</option>
                  {domicilios.map((d) => (
                    <option key={d.codigo} value={d.codigo}>{d.descripcion}</option>
                  ))}
                </select>
                <button type="button" className="secondary" disabled={busy} onClick={() => void buscarDomicilios()}>Buscar en ARCA</button>
              </div>
            </label>
          )}
        </div>
      )}

      <h4 style={{ marginBottom: 4 }}>Mercadería</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        El código es el de las tablas de ARCA (por ejemplo 6.24 Cuadril sin tapa). Los cortes con hueso y las medias reses llevan número de tropa.
      </p>
      {form.items.map((it, idx) => (
        <RecItemRow
          key={it.key}
          index={idx}
          item={it}
          catalog={catalog}
          products={productOptions}
          onChange={(patch) => {
            if (patch.productId !== undefined && patch.productId && !it.codTipoProd) {
              const remembered = codes.get(patch.productId);
              if (remembered) patch = { ...patch, codTipoProd: remembered };
            }
            setItem(it.key, patch);
          }}
          onRemove={form.items.length > 1 ? () => set({ items: form.items.filter((x) => x.key !== it.key) }) : undefined}
        />
      ))}
      <button type="button" className="secondary" onClick={() => set({ items: [...form.items, emptyItem()] })}>+ Otro renglón</button>

      <h4 style={{ marginBottom: 4 }}>Transporte</h4>
      <div className="form-grid">
        <label>
          CUIT del transportista
          <input inputMode="numeric" value={form.cuitTransportista} onChange={(e) => set({ cuitTransportista: e.target.value })} />
        </label>
        <label>
          Transportista (nombre)
          <input value={form.transportistaName} onChange={(e) => set({ transportistaName: e.target.value })} />
        </label>
        <label>
          CUIT/CUIL del conductor (opcional)
          <input inputMode="numeric" value={form.cuitConductor} onChange={(e) => set({ cuitConductor: e.target.value })} />
        </label>
        <label>
          Patente del vehículo
          <input value={form.dominioVehiculo} onChange={(e) => set({ dominioVehiculo: e.target.value.toUpperCase() })} />
        </label>
        <label>
          Patente del acoplado (si tiene)
          <input value={form.dominioAcoplado} onChange={(e) => set({ dominioAcoplado: e.target.value.toUpperCase() })} />
        </label>
        <label>
          Fecha de inicio del viaje
          <input type="date" min={today} value={form.fechaInicioViaje} onChange={(e) => set({ fechaInicioViaje: e.target.value })} />
        </label>
        <label>
          Distancia (km)
          <input type="text" inputMode="decimal" value={form.distanciaKm} onChange={(e) => set({ distanciaKm: e.target.value })} />
        </label>
        <label>
          Observaciones
          <input value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      </div>

      {problems.length > 0 && (
        <ul style={{ color: "#8b1e1e", fontSize: 13 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {message && <p>{message}</p>}
      <div className="form-actions">
        <button disabled={busy} onClick={() => void handleEmit()}>Emitir remito con ARCA</button>
        <button className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

function RecItemRow({
  index,
  item,
  catalog,
  products,
  onChange,
  onRemove
}: {
  index: number;
  item: RecItemForm;
  catalog: RecSettings["catalog"];
  products: Array<RecProductOption & { label: string }>;
  onChange: (patch: Partial<RecItemForm>) => void;
  onRemove?: () => void;
}) {
  const [search, setSearch] = useState("");
  const matches = searchTiposCarne(catalog, search);
  const current = catalog.tiposCarne.find((t) => t.codigo === item.codTipoProd);
  return (
    <div className="form-grid" style={{ borderTop: index > 0 ? "1px dashed #ccc" : undefined, paddingTop: index > 0 ? 6 : 0 }}>
      <label>
        Producto (opcional)
        <select
          value={item.productId}
          onChange={(e) => {
            const p = products.find((x) => x.id === e.target.value);
            onChange({ productId: e.target.value, productName: p?.name ?? item.productName });
          }}
        >
          <option value="">(sin producto)</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label>
        Código ARCA {current ? <span className="muted">· {current.descripcion}</span> : null}
        <input
          value={search || item.codTipoProd}
          placeholder="Ej.: 6.24 o cuadril"
          onChange={(e) => {
            const v = e.target.value;
            setSearch(v);
            if (/^\d{1,2}\.\d{1,3}$/.test(v.trim())) onChange({ codTipoProd: v.trim() });
          }}
          onBlur={() => window.setTimeout(() => setSearch(""), 200)}
        />
        {search && matches.length > 0 && (
          <div style={{ border: "1px solid #ccc", background: "#fff", maxHeight: 180, overflowY: "auto", fontSize: 12 }}>
            {matches.map((m) => (
              <div
                key={m.codigo}
                style={{ padding: "3px 6px", cursor: "pointer" }}
                onMouseDown={() => {
                  onChange({ codTipoProd: m.codigo, productName: item.productName || m.descripcion });
                  setSearch("");
                }}
              >
                {m.codigo} · {m.descripcion}
              </div>
            ))}
          </div>
        )}
      </label>
      <label>
        Tropa
        <input inputMode="numeric" value={item.tropa} onChange={(e) => onChange({ tropa: e.target.value.replace(/\D/g, "") })} />
      </label>
      <label>
        Kilos
        <input type="text" inputMode="decimal" value={item.kilos} onChange={(e) => onChange({ kilos: e.target.value })} />
      </label>
      <label>
        Unidades
        <input type="text" inputMode="decimal" value={item.unidades} onChange={(e) => onChange({ unidades: e.target.value })} />
      </label>
      {onRemove && (
        <div style={{ alignSelf: "end" }}>
          <button type="button" className="secondary" onClick={onRemove}>Quitar</button>
        </div>
      )}
    </div>
  );
}
