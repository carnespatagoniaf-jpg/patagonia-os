import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ArcaCertificateStatus, FiscalSettings } from "./invoicing-service";
import { ISSUER_CONDITION_LABEL, formatCuit } from "./invoicing-view";
import { ARCA_STEPS, arcaStepDone, currentArcaStep, type ArcaSetupState, type ArcaStepId } from "./arca-setup";

interface Props {
  companyId: string | null;
  settings: FiscalSettings | null;
  cert: ArcaCertificateStatus | null;
  loading: boolean;
  busy: boolean;
  /** Último mensaje de la pantalla: se muestra dentro del paso abierto, al lado de los botones. */
  message: string;
  /** El formulario de datos fiscales (paso 1), con su botón Guardar. */
  fiscalForm: ReactNode;
  /** Aviso extra en el paso 1 (ej. lo que falta para el Remito R). */
  fiscalNote?: string;
  /** Abrir directo el paso 1 (llegó desde el Remito R porque faltaban datos). */
  openDatos?: boolean;
  onDownloadRequest: (regenerate?: boolean) => void;
  onUploadCertificate: (file: File | undefined) => void;
  onCheck: () => void;
}

/** Nombre de una tecla/botón de ARCA, para que la persona lo encuentre en pantalla. */
function K({ children }: { children: ReactNode }) {
  return <span className="arca-key">{children}</span>;
}

function ackKey(companyId: string | null) {
  return `patagonia-arca-setup-${companyId ?? "demo"}`;
}

function readAck(companyId: string | null): { arcaCert: boolean; permission: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(ackKey(companyId)) ?? "{}");
    return { arcaCert: Boolean(raw.arcaCert), permission: Boolean(raw.permission) };
  } catch {
    return { arcaCert: false, permission: false };
  }
}

export function ArcaSetup({ companyId, settings, cert, loading, busy, message, fiscalForm, fiscalNote, openDatos, onDownloadRequest, onUploadCertificate, onCheck }: Props) {
  const [ack, setAck] = useState(() => readAck(companyId));
  useEffect(() => setAck(readAck(companyId)), [companyId]);
  function saveAck(next: typeof ack) {
    setAck(next);
    try {
      localStorage.setItem(ackKey(companyId), JSON.stringify(next));
    } catch {
      // sin localStorage: se marca solo mientras dure la página
    }
  }

  const state: ArcaSetupState = {
    hasSettings: Boolean(settings),
    enabled: Boolean(settings?.enabled),
    usesShared: Boolean(cert?.usesShared),
    hasRequest: Boolean(cert?.hasRequest),
    hasCertificate: Boolean(cert?.hasCertificate),
    ackArcaCert: ack.arcaCert,
    ackPermission: ack.permission
  };
  const current = currentArcaStep(state);
  const [open, setOpen] = useState<ArcaStepId | null>(openDatos ? "datos" : null);
  const [showAll, setShowAll] = useState(false);
  // Al avanzar (guardó, bajó, subió…) se abre solo el paso que sigue.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setOpen(null);
  }, [current]);
  const openStep = open ?? current;

  const doneCount = ARCA_STEPS.filter((s) => arcaStepDone(s.id, state)).length;
  const alias = cert?.alias ?? "patagonia";
  const cuit = settings ? formatCuit(settings.cuit) : "";
  const csrName = settings ? `pedido-certificado-${settings.cuit}.csr` : "pedido-certificado.csr";
  const pvSystem = settings?.taxCondition === "responsable_inscripto" ? "RECE para aplicativo y web services" : "Factura Electrónica - Monotributo - Web Services";

  if (loading) return <section className="panel arca-setup"><p className="muted">Cargando…</p></section>;

  // Ya conectado: una línea con el estado y, si hace falta, los pasos.
  if (state.enabled && !showAll && !open) {
    return (
      <section className="panel arca-setup arca-done">
        <div className="arca-done-row">
          <span className="arca-num ok">✓</span>
          <div>
            <b>Factura electrónica activa</b>
            <p className="muted">
              {settings && `${settings.businessName} · CUIT ${cuit} · ${ISSUER_CONDITION_LABEL[settings.taxCondition]} · Punto de venta ${settings.pointOfSale}`}
              {cert?.certExpiresAt && ` · certificado vence el ${new Date(cert.certExpiresAt).toLocaleDateString("es-AR")}`}
            </p>
          </div>
          <div className="row-actions">
            <button className="secondary" onClick={() => setOpen("datos")}>Cambiar datos</button>
            <button className="secondary" disabled={busy} onClick={onCheck}>{busy ? "Probando…" : "Probar conexión"}</button>
            <button className="secondary" onClick={() => setShowAll(true)}>Ver los pasos</button>
          </div>
        </div>
        {fiscalNote && <p className="message warning" style={{ margin: "10px 0 0" }}>{fiscalNote}</p>}
      </section>
    );
  }

  const stepMessage = message ? <div className={/no |inválid|error|falt|revis/i.test(message) ? "message warning arca-msg" : "message arca-msg"}>{message}</div> : null;

  function header(id: ArcaStepId, index: number, title: string, summary?: ReactNode) {
    const done = arcaStepDone(id, state);
    const isOpen = openStep === id;
    const where = ARCA_STEPS[index].where;
    return (
      <button type="button" className="arca-step-head" onClick={() => setOpen(isOpen ? (id === current ? id : null) : id)} aria-expanded={isOpen}>
        <span className={`arca-num${done ? " ok" : id === current ? " now" : ""}`}>{done ? "✓" : index + 1}</span>
        <span className="arca-step-title">
          {title}
          {done && summary && <small>{summary}</small>}
        </span>
        <span className={`arca-where ${where}`}>{where === "arca" ? "En la página de ARCA" : "En Patagonia OS"}</span>
      </button>
    );
  }

  function stepClass(id: ArcaStepId) {
    const done = arcaStepDone(id, state);
    return `arca-step${done ? " done" : id === current ? " now" : " later"}${openStep === id ? " open" : ""}`;
  }

  return (
    <section className="panel arca-setup">
      <div className="arca-progress-head">
        <div>
          <h2>{state.enabled ? "Factura electrónica activa" : "Activar la factura electrónica"}</h2>
          <p className="muted">Se hace una sola vez. Algunos pasos son acá y otros en la página de ARCA, y te vamos diciendo cuál es cuál. Lleva unos 20 minutos.</p>
        </div>
        <span className="arca-count">{doneCount === ARCA_STEPS.length ? "Listo ✓" : `Paso ${ARCA_STEPS.findIndex((s) => s.id === current) + 1} de ${ARCA_STEPS.length}`}</span>
      </div>
      <div className="arca-bar"><i style={{ width: `${Math.round((doneCount / ARCA_STEPS.length) * 100)}%` }} /></div>
      <div className="arca-pills">
        {ARCA_STEPS.map((s, i) => (
          <button key={s.id} type="button" className={`arca-pill${arcaStepDone(s.id, state) ? " done" : s.id === current ? " now" : ""}`} onClick={() => setOpen(s.id)}>
            <b>{i + 1}. {s.short}</b>
            <span>{s.where === "arca" ? "en ARCA" : "Patagonia OS"}</span>
          </button>
        ))}
      </div>

      {/* 1. Datos */}
      <div className={stepClass("datos")}>
        {header("datos", 0, "Datos del negocio", settings && `${settings.businessName} · CUIT ${cuit} · ${ISSUER_CONDITION_LABEL[settings.taxCondition]} · PV ${settings.pointOfSale}`)}
        {openStep === "datos" && (
          <div className="arca-step-body">
            <div className="arca-what">
              <b>¿Qué es esto?</b> Son los datos que salen impresos en cada factura y con los que ARCA te reconoce. Tienen que ser <b>iguales a los de ARCA</b>: el CUIT
              con el que entrás a la página de ARCA y la razón social del titular. El <b>punto de venta</b> es un número que se crea en ARCA (paso 5); si todavía no lo
              creaste, poné el que vas a usar (por ejemplo 5) y después creás ese mismo.
            </div>
            {fiscalNote && <p className="message warning" style={{ margin: "0 0 10px" }}>{fiscalNote}</p>}
            {fiscalForm}
            {stepMessage}
          </div>
        )}
      </div>

      {/* 2. Pedido de certificado */}
      <div className={stepClass("pedido")}>
        {header("pedido", 1, "Bajar el pedido de certificado", state.usesShared ? "No hace falta: usás el certificado de Patagonia OS" : cert?.hasRequest ? <span className="arca-file">📄 {csrName}</span> : undefined)}
        {openStep === "pedido" && (
          <div className="arca-step-body">
            <div className="arca-what">
              <b>¿Qué es esto?</b> Para facturar, ARCA le da a cada negocio un <b>certificado</b>: una "llave" que deja a Patagonia OS pedir facturas a tu nombre. Para
              armarlo, ARCA necesita un archivo de pedido que <b>termina en .csr</b>. Ese archivo lo hace Patagonia OS con tu CUIT: lo bajás acá y en el paso 3 lo subís en ARCA.
            </div>
            {state.usesShared ? (
              <p>Este negocio factura con el certificado de Patagonia OS, que es de su mismo CUIT: este paso y los dos siguientes no hacen falta.</p>
            ) : (
              <ol className="arca-do">
                <li>
                  Tocá{" "}
                  <button disabled={busy || !settings} onClick={() => onDownloadRequest()}>{cert?.hasRequest ? "Volver a bajar el pedido" : "Bajar pedido de certificado"}</button>
                  {!settings && <span className="muted"> (primero guardá los datos del paso 1)</span>}
                </li>
                <li>Se guarda en la carpeta <b>Descargas</b> con el nombre <span className="arca-file">📄 {csrName}</span>. No lo abras ni le cambies el nombre.</li>
              </ol>
            )}
            {stepMessage}
          </div>
        )}
      </div>

      {/* 3. Certificado en ARCA */}
      <div className={stepClass("arca_cert")}>
        {header("arca_cert", 2, "Crear el certificado en ARCA", state.usesShared ? "No hace falta" : "Ya está")}
        {openStep === "arca_cert" && (
          <div className="arca-step-body">
            <div className="arca-what">
              <b>¿Qué es esto?</b> Ahora vas a la página de ARCA a darle el pedido (.csr) y ARCA te devuelve el <b>certificado</b>, que es otro archivo y <b>termina en .crt</b>.
              En la pantalla de ARCA te va a pedir un archivo para crear el alias: <b>es el .csr</b> del paso 2, no el .crt.
            </div>
            <ol className="arca-do">
              <li>
                Entrá a <b>arca.gob.ar</b> con la clave fiscal del CUIT <b>{cuit || "del negocio"}</b> (tiene que ser <b>nivel 3</b>).{" "}
                <a className="arca-link" href="https://auth.afip.gob.ar/contribuyente_/login.xhtml" target="_blank" rel="noreferrer">Abrir ARCA ↗</a>
              </li>
              <li>
                Buscá el servicio <K>Administración de Certificados Digitales</K>.
                <span className="arca-hint">
                  ¿No te aparece? Entrá a <K>Administrador de Relaciones de Clave Fiscal</K> → <K>Adherir servicio</K> → ARCA → Servicios Interactivos → Administración de
                  Certificados Digitales → Confirmar. Cerrá la sesión de ARCA y volvé a entrar.
                </span>
              </li>
              <li>Tocá <K>Agregar alias</K>. En Alias escribí <b>{alias}</b>.</li>
              <li>En <K>Seleccionar archivo</K> elegí <span className="arca-file">📄 {csrName}</span> (está en Descargas) → <K>Agregar alias</K>.</li>
              <li>En la lista de alias, en "{alias}": <K>Ver</K> → <K>Descargar</K>. Se te baja el certificado, que termina en <b>.crt</b>.</li>
            </ol>
            <div className="arca-errors">
              <b>¿ARCA te dice "El Request enviado es inválido"?</b>
              <ul>
                <li>Elegiste otro archivo: tiene que ser el <b>.csr</b> del paso 2 (no un .crt, ni un pedido viejo).</li>
                <li>Entraste a ARCA con otro CUIT: tiene que ser el <b>{cuit || "mismo que cargaste en el paso 1"}</b>.</li>
                <li>Ya existe un alias "{alias}": entrá a ese y agregale el certificado ahí, en vez de crear otro.</li>
                <li>Si nada de eso, volvé al paso 2, tocá "Volver a bajar el pedido" y probá con el archivo nuevo.</li>
              </ul>
            </div>
            <div className="arca-foot">
              <button onClick={() => saveAck({ ...ack, arcaCert: true })}>Ya tengo el .crt → seguir</button>
              <span className="muted">¿Te trabaste? Mandanos una foto de la pantalla de ARCA.</span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Subir */}
      <div className={stepClass("subir")}>
        {header("subir", 3, "Subir el certificado acá", cert?.hasCertificate && cert.certExpiresAt ? `Cargado · vence el ${new Date(cert.certExpiresAt).toLocaleDateString("es-AR")}` : state.usesShared ? "No hace falta" : undefined)}
        {openStep === "subir" && (
          <div className="arca-step-body">
            <div className="arca-what">
              <b>¿Qué es esto?</b> Le das a Patagonia OS el certificado (.crt) que bajaste de ARCA, para que pueda pedir las facturas. Queda guardado cifrado: nadie lo puede ver.
            </div>
            <ol className="arca-do">
              <li>
                Elegí el archivo que bajaste de ARCA (termina en <b>.crt</b>, está en Descargas):{" "}
                <input type="file" accept=".crt,.cer,.pem,.txt" disabled={busy || !cert?.hasRequest} onChange={(e) => onUploadCertificate(e.target.files?.[0])} />
              </li>
              <li>Tiene que aparecer <b>"Cargado · vence el …"</b>.</li>
            </ol>
            {!cert?.hasRequest && <p className="message warning" style={{ margin: "10px 0 0" }}>Primero bajá el pedido de certificado (paso 2): el certificado tiene que salir de ese pedido.</p>}
            <div className="arca-errors">
              <b>¿Dice que el certificado no corresponde?</b>
              <ul>
                <li>Es de otro pedido: si volviste a bajar el pedido en el paso 2, el certificado tiene que ser el de ese pedido nuevo (en ARCA, agregá el certificado de nuevo con el .csr nuevo).</li>
                <li>Elegiste el .csr en vez del .crt: acá va el que bajaste de ARCA.</li>
              </ul>
            </div>
            {stepMessage}
          </div>
        )}
      </div>

      {/* 5. Permiso y punto de venta */}
      <div className={stepClass("permiso")}>
        {header("permiso", 4, "Dar el permiso y crear el punto de venta", "Hecho")}
        {openStep === "permiso" && (
          <div className="arca-step-body">
            <div className="arca-what">
              <b>¿Qué es esto?</b> Dos cosas en ARCA. Primero, <b>autorizar</b> a ese certificado a hacer facturas (ARCA lo llama "computador fiscal"). Segundo, tener un
              <b> punto de venta</b> para factura por sistema: es el número que va en cada factura (0005-00000123).
            </div>
            <p style={{ margin: "0 0 6px" }}><b>A. El permiso</b></p>
            <ol className="arca-do">
              <li>En ARCA entrá a <K>Administrador de Relaciones de Clave Fiscal</K> → <K>Nueva Relación</K>.</li>
              <li>Servicio: <K>ARCA</K> → <K>WebServices</K> → <K>Facturación Electrónica</K>.</li>
              <li>Representante: <K>Buscar</K> → elegí el computador fiscal <b>"{alias}"</b> → <K>Confirmar</K>.</li>
            </ol>
            <p style={{ margin: "12px 0 6px" }}><b>B. El punto de venta</b></p>
            <ol className="arca-do">
              <li>En ARCA entrá a <K>Administración de puntos de venta y domicilios</K> → <K>A/B/M de Puntos de venta</K>.</li>
              <li>
                Si no tenés el <b>{settings?.pointOfSale ?? "punto de venta"}</b>, tocá <K>Agregar</K>: número <b>{settings?.pointOfSale ?? "el que pusiste en el paso 1"}</b>, sistema{" "}
                <b>"{pvSystem}"</b>.
              </li>
              <li>No sirve uno de "Factura en Línea" ni de controlador fiscal: tiene que ser de <b>Web Services</b>. Si el número que tenés es de otro tipo, creá otro y cambialo en el paso 1.</li>
            </ol>
            <div className="arca-foot">
              <button onClick={() => saveAck({ ...ack, permission: true })}>Ya lo hice → seguir</button>
            </div>
          </div>
        )}
      </div>

      {/* 6. Probar */}
      <div className={stepClass("probar")}>
        {header("probar", 5, "Probar la conexión", "Funciona")}
        {openStep === "probar" && (
          <div className="arca-step-body">
            <div className="arca-what">
              <b>¿Qué es esto?</b> Patagonia OS le pregunta a ARCA si está todo bien. Si da bien, la factura queda activa: al cobrar en Mostrador o en Clientes aparece "Factura".
            </div>
            <div className="arca-foot">
              <button disabled={busy || !settings} onClick={onCheck}>{busy ? "Probando…" : "Probar conexión con ARCA"}</button>
            </div>
            {settings?.lastCheckAt && !settings.lastCheckOk && (
              <div className="arca-errors">
                <b>La última prueba ({new Date(settings.lastCheckAt).toLocaleString("es-AR")}) falló:</b> {settings.lastCheckMessage ?? ""}
                <ul>
                  <li>Si habla de permiso, autorización o "computador fiscal": falta la parte A del paso 5.</li>
                  <li>Si habla del punto de venta: no existe en ARCA o no es de Web Services (parte B del paso 5).</li>
                  <li>Si habla del certificado: volvé a subirlo (paso 4), o generá uno nuevo desde el paso 2.</li>
                </ul>
              </div>
            )}
            {stepMessage}
          </div>
        )}
      </div>

      <div className="arca-bottom">
        {state.enabled && <button className="link-button" onClick={() => { setShowAll(false); setOpen(null); }}>Cerrar los pasos</button>}
        {cert?.hasCertificate && !cert.usesShared && (
          <span className="muted">
            ¿Hay que renovar el certificado o cambió algo?{" "}
            <button className="link-button" disabled={busy} onClick={() => onDownloadRequest(true)}>Generar un certificado nuevo</button>
          </span>
        )}
      </div>
    </section>
  );
}
