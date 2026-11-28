// Quita la firma Authenticode de un ejecutable PE (lo mismo que `signtool remove /s`),
// sin depender del Windows SDK.
//
// node.exe viene firmado por la OpenJS Foundation. Al inyectar el bundle (postject) esa
// firma queda rota: Windows mostraría "firma no válida", que es peor que "sin firma".
// Por eso se quita ANTES de inyectar, y después se firma con el certificado propio.
//
// La firma vive en la "tabla de certificados" (directorio de datos 4, IMAGE_DIRECTORY_ENTRY_SECURITY),
// que no se carga en memoria y siempre está al final del archivo. Quitarla = poner esa entrada
// en cero y cortar el archivo donde empezaba la tabla. También se pone en cero el CheckSum del
// encabezado (Windows no lo exige para programas comunes, y el original ya no vale).

const PE32 = 0x10b;
const PE32_PLUS = 0x20b;
const SECURITY_DIRECTORY = 4;

function locate(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) throw new Error("No es un ejecutable de Windows (falta MZ).");
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("No es un ejecutable de Windows (falta la firma PE).");
  }
  const optional = peOffset + 24;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== PE32 && magic !== PE32_PLUS) throw new Error(`Encabezado opcional desconocido (0x${magic.toString(16)}).`);
  const directories = optional + (magic === PE32_PLUS ? 112 : 96);
  const numberOfRvaAndSizes = buffer.readUInt32LE(directories - 4);
  return {
    checksumOffset: optional + 64,
    securityEntry: numberOfRvaAndSizes > SECURITY_DIRECTORY ? directories + SECURITY_DIRECTORY * 8 : null,
  };
}

/** Devuelve { signed, offset, size } de la tabla de certificados. */
export function readSignatureInfo(buffer) {
  const { securityEntry } = locate(buffer);
  if (securityEntry === null) return { signed: false, offset: 0, size: 0 };
  const offset = buffer.readUInt32LE(securityEntry);
  const size = buffer.readUInt32LE(securityEntry + 4);
  return { signed: offset !== 0 && size !== 0, offset, size };
}

/**
 * Devuelve un Buffer nuevo sin firma (o el mismo si no tenía).
 * Se niega si la tabla de certificados no está al final: no sería un ejecutable normal.
 */
export function removeSignature(buffer) {
  const { securityEntry, checksumOffset } = locate(buffer);
  const info = readSignatureInfo(buffer);
  if (!info.signed) return { buffer, removed: false };
  const end = info.offset + info.size;
  // La tabla se alinea a 8 bytes: puede sobrar relleno al final.
  if (info.offset > buffer.length || end > buffer.length || buffer.length - end >= 8) {
    throw new Error("La firma no está al final del archivo: no se toca el ejecutable.");
  }
  const out = Buffer.from(buffer.subarray(0, info.offset));
  out.writeUInt32LE(0, securityEntry);
  out.writeUInt32LE(0, securityEntry + 4);
  out.writeUInt32LE(0, checksumOffset);
  return { buffer: out, removed: true };
}
