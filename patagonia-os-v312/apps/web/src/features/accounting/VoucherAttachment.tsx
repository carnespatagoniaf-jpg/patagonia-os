import { useRef, useState } from "react";
import { attachVoucherFile, removeVoucherFile, voucherFileUrl } from "./accounting-service";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return fallback;
}

/**
 * Foto o PDF de la factura del proveedor (migración 156). "Adjuntar" abre la
 * cámara en el celular o elige un archivo; "Ver" lo abre con un enlace que
 * dura 10 minutos. El Contador solo puede ver.
 */
export function VoucherAttachment({
  companyId,
  voucher,
  canWrite,
  onChanged
}: {
  companyId: string | null;
  voucher: { id: string; attachmentPath?: string | null };
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    if (!companyId) return;
    setBusy(true);
    setError("");
    try {
      await attachVoucherFile(companyId, voucher, file);
      onChanged("Archivo de la factura guardado.");
    } catch (err) {
      setError(errorText(err, "No se pudo subir el archivo."));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (!voucher.attachmentPath) return;
    // La pestaña se abre antes de pedir el enlace, así el navegador no la bloquea.
    const tab = window.open("", "_blank");
    try {
      const url = await voucherFileUrl(voucher.attachmentPath);
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      setError(errorText(err, "No se pudo abrir el archivo."));
    }
  }

  async function remove() {
    if (!window.confirm("¿Quitar el archivo de esta factura? Los datos de la factura quedan.")) return;
    setBusy(true);
    try {
      await removeVoucherFile(voucher);
      onChanged("Archivo quitado.");
    } catch (err) {
      setError(errorText(err, "No se pudo quitar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {voucher.attachmentPath ? (
        <>
          <button className="link-button" onClick={() => void open()} title="Ver la foto o el PDF de la factura">📎 Ver</button>
          {canWrite && <button className="link-button" disabled={busy} onClick={() => void remove()}>Quitar</button>}
        </>
      ) : (
        canWrite && (
          <button className="link-button" disabled={busy || !companyId} onClick={() => input.current?.click()} title="Foto con el celular o PDF de la factura">
            {busy ? "Subiendo…" : "📎 Adjuntar"}
          </button>
        )
      )}
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      {error && <span className="num-negative" style={{ fontSize: 12 }}>{error}</span>}
    </span>
  );
}
