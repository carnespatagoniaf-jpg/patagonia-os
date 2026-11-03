import qrcode from "qrcode-generator";

// QR de ARCA como imagen de puntos para la térmica (ESC/POS GS v 0). Lógica pura, testeada en qr-raster.test.ts.
//
// Por qué no el QR "nativo" (GS ( k): muchas térmicas no lo traen y, en vez de dibujarlo, imprimen sus
// parámetros y la URL como texto ("1A21C1E041P0https://www.afip.gob.ar/fe/qr/…", Carnes Premium, 03/11/2026).
// La imagen de puntos la entienden prácticamente todas.

export interface QrRaster {
  /** Bytes por fila (8 puntos por byte). */
  bytesPerRow: number;
  /** Alto en puntos. */
  height: number;
  /** Puntos de cada fila, de izquierda a derecha; 1 = negro. */
  bits: Uint8Array;
  /** Tamaño de cada cuadradito del QR, en puntos. */
  scale: number;
  modules: number;
}

/** Margen blanco alrededor del QR, en cuadraditos. */
const QUIET = 2;

/**
 * Arma el QR en una imagen de como mucho `maxDots` de ancho (300 entra en papel de 58 mm, que imprime 384 puntos,
 * y en el de 80 mm). Cada cuadradito ocupa entre 3 y 5 puntos: más chico no lo lee bien un celular.
 */
export function qrRaster(data: string, maxDots = 300): QrRaster {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const modules = qr.getModuleCount();
  const total = modules + QUIET * 2;
  const scale = Math.max(3, Math.min(5, Math.floor(maxDots / total)));
  const size = total * scale;
  const bytesPerRow = Math.ceil(size / 8);
  const bits = new Uint8Array(bytesPerRow * size);
  for (let y = 0; y < size; y++) {
    const r = Math.floor(y / scale) - QUIET;
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - QUIET;
      if (r >= 0 && c >= 0 && r < modules && c < modules && qr.isDark(r, c)) {
        bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { bytesPerRow, height: size, bits, scale, modules };
}

/** Comando ESC/POS "GS v 0" (imagen de puntos, modo normal) con la imagen del QR. */
export function qrRasterCommand(data: string, maxDots = 300): number[] {
  const img = qrRaster(data, maxDots);
  const out = [0x1d, 0x76, 0x30, 0, img.bytesPerRow & 0xff, (img.bytesPerRow >> 8) & 0xff, img.height & 0xff, (img.height >> 8) & 0xff];
  for (const b of img.bits) out.push(b);
  return out;
}
