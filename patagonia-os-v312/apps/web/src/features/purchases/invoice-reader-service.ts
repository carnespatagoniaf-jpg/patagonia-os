import { supabase } from "../../lib/supabase";
import { parseReadInvoice, type ReadInvoice } from "./invoice-draft";

/** Lado mayor de la foto que se manda: alcanza para leer una factura y pesa poco. */
const MAX_SIDE = 2000;
const MAX_PDF_BYTES = 6 * 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(blob);
  });
}

/** Achica la foto del celular (suele tener 4000 px y 5 MB) a JPEG de 2000 px. */
async function shrinkImage(file: File): Promise<{ data: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("No se pudo abrir la foto. Probá con otra (JPG o PNG).");
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Este navegador no puede preparar la foto.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("No se pudo preparar la foto.");
  return { data: await blobToBase64(blob), mediaType: "image/jpeg" };
}

/**
 * Manda la foto o el PDF a la Edge Function invoice-reader y devuelve lo que
 * dice el papel. No guarda nada.
 */
export async function readInvoiceFile(file: File): Promise<ReadInvoice> {
  if (!supabase) throw new Error("La lectura de facturas necesita estar conectado al sistema.");

  let payload: { data: string; media_type: string };
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("El PDF es muy grande (más de 6 MB).");
    payload = { data: await blobToBase64(file), media_type: "application/pdf" };
  } else if (file.type.startsWith("image/") || file.type === "") {
    const image = await shrinkImage(file);
    payload = { data: image.data, media_type: image.mediaType };
  } else {
    throw new Error("Elegí una foto o un PDF.");
  }

  const { data, error } = await supabase.functions.invoke("invoice-reader", { body: payload });
  if (error) {
    let message = "No se pudo leer la factura. Probá de nuevo.";
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // respuesta sin JSON: queda el mensaje genérico
      }
    }
    throw new Error(message);
  }
  return parseReadInvoice((data as { invoice?: unknown } | null)?.invoice);
}
