import { useState } from "react";
import type { SystelClient } from "./systel-client";
import { compareWithBackup, takeProductBackup, verifyBackup, type ProductBackup } from "./systel-product-barcode";
import type { SystelLayout } from "./systel-plu";

/**
 * "Código de barras de cada producto" (Stock → Balanza, solo empresas piloto Systel).
 *
 * Habilitado: respaldo de los productos y comparación con el respaldo (SOLO LECTURA).
 * Preparado pero DESHABILITADO hasta la autorización del dueño: probar en un producto y restaurar
 * (escriben en la balanza: systel-product-barcode.ts). Para habilitarlo hay que cambiar
 * `SYSTEL_PRODUCT_BARCODE_WRITE_ENABLED` y publicar: no se puede activar desde la pantalla.
 */
export const SYSTEL_PRODUCT_BARCODE_WRITE_ENABLED = false;

const BACKUP_KEY = "patagonia-systel-product-backup";

export function loadProductBackup(): ProductBackup | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as ProductBackup) : null;
  } catch {
    return null;
  }
}

export interface ProductBarcodePanelProps {
  busy: boolean;
  /** Productos de Patagonia con código de balanza (para saber qué números respaldar). */
  numbers: number[];
  /** Abre la conexión (la del panel) y devuelve el cliente de solo lectura y el formato de producto, o null. */
  withReadClient: <T>(fn: (client: SystelClient, layout: SystelLayout) => Promise<T>) => Promise<T | null>;
  /** Manda el resultado a soporte. */
  report: (step: string, detail: string) => void;
}

export function SystelProductBarcodePanel(p: ProductBarcodePanelProps) {
  const [backup, setBackup] = useState<ProductBackup | null>(() => loadProductBackup());
  const [note, setNote] = useState("");
  const [testPlu, setTestPlu] = useState("5");
  const check = backup ? verifyBackup(backup) : null;

  async function handleBackup() {
    setNote("");
    const r = await p.withReadClient(async (client, layout) => takeProductBackup(client, layout, p.numbers));
    if (!r) return;
    const v = verifyBackup(r.backup);
    // Completo = se leyeron TODOS los productos pedidos (y al menos uno), con la huella y la forma correctas.
    const complete = p.numbers.length > 0 && r.missing.length === 0 && r.backup.records.length === p.numbers.length && v.ok;
    if (complete) {
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(r.backup));
      } catch {
        // se manda igual a soporte
      }
      setBackup(r.backup);
    }
    const detail = `respaldo ${r.backup.records.length} de ${p.numbers.length} productos${r.missing.length ? `; NO se pudieron leer: ${r.missing.join(", ")}` : ""} · ${v.detail}`;
    setNote(complete ? `Respaldo completo y verificado: ${detail}.` : `Respaldo INCOMPLETO (no se guardó como válido): ${detail}.`);
    // El respaldo completo (todos los registros) queda en soporte: se puede restaurar aunque se pierda esta PC.
    p.report("respaldo de productos (solo lectura)", `${detail}\n${JSON.stringify(r.backup)}`);
  }

  async function handleCompare() {
    if (!backup) return;
    setNote("");
    const states = await p.withReadClient(async (client) => compareWithBackup(client, backup));
    if (!states) return;
    const count = (s: string) => states.filter((x) => x.state === s).length;
    const text = `iguales al respaldo: ${count("igual")} · solo cambió el código: ${count("solo_codigo")} · con otra diferencia: ${count("otra_diferencia")} · sin leer: ${count("sin_lectura")}`;
    setNote(`Comparación (solo lectura): ${text}.`);
    p.report("comparar con el respaldo (solo lectura)", `${text}\n${JSON.stringify(states.filter((x) => x.state !== "igual"))}`);
  }

  return (
    <div className="panel" style={{ padding: 12, display: "grid", gap: 8 }}>
      <strong>Código de barras de cada producto</strong>
      <span className="muted" style={{ fontSize: 13 }}>
        Para que el ticket traiga, debajo de cada artículo, el código con el producto y sus kilos o unidades. Primero se hace un respaldo de todos los productos de la balanza (solo lectura).
      </span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="secondary" disabled={p.busy} onClick={() => void handleBackup()}>Respaldar los productos (solo lectura)</button>
        <button className="secondary" disabled={p.busy || !backup} onClick={() => void handleCompare()}>Comparar con el respaldo (solo lectura)</button>
      </div>
      {backup && check && (
        <span style={{ fontSize: 13 }} className={check.ok ? "" : "num-negative"}>
          Respaldo guardado {new Date(backup.takenAt).toLocaleString("es-AR")}: {check.detail}{check.ok ? "" : " (NO usar)"}
        </span>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label className="muted" style={{ fontSize: 13 }}>
          Producto N.º{" "}
          <input value={testPlu} onChange={(e) => setTestPlu(e.target.value.replace(/\D/g, ""))} style={{ width: 70 }} disabled={!SYSTEL_PRODUCT_BARCODE_WRITE_ENABLED} />
        </label>
        <button disabled title="Deshabilitado hasta la autorización">Probar en este producto</button>
        <button className="secondary" disabled title="Deshabilitado hasta la autorización">Restaurar desde el respaldo</button>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        Cambiar el código en la balanza está deshabilitado hasta que lo autorice el responsable. Ningún botón de este recuadro cambia precios, productos ni ventas.
      </span>
      {note && <span style={{ fontSize: 13 }}>{note}</span>}
    </div>
  );
}
