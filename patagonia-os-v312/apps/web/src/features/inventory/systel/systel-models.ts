/**
 * Balanzas Systel y qué puede hacer Patagonia con cada una. `evidence`:
 * - "documentado": lo dice un documento oficial de Systel, falta probarlo en una balanza real.
 * - "real": probado en una balanza real de un cliente.
 * La carga real de productos queda bloqueada hasta que haya evidencia "real"
 * (la prueba controlada pasa a "real" el modelo en el que se hizo).
 */

export type SystelModelId = "cuora_max" | "cuora_2" | "cuora_neo" | "croma_clipse_bumer";

export interface SystelModel {
  id: SystelModelId;
  name: string;
  connection: string;
  products: "cable" | "archivo_qendra" | "archivo_ftp" | "no";
  weight: "protocolo_cuora" | "protocolo_rs232" | "no";
  evidence: "documentado" | "real";
  notes: string;
}

export const SYSTEL_MODELS: SystelModel[] = [
  {
    id: "cuora_max",
    name: "Cuora Max",
    connection: "USB (chip FTDI, 115200). También Ethernet/WiFi (TCP 10001), que desde el navegador necesita un programa en la PC.",
    products: "cable",
    weight: "protocolo_cuora",
    evidence: "documentado",
    notes: "Protocolo V6.0/V6.2/V7.0: lectura, respaldo, cambio de precio que conserva todo y alta de productos. Sin el cable, archivo para Qendra."
  },
  {
    id: "cuora_2",
    name: "Cuora / Cuora 2",
    connection: "USB o RS-485.",
    products: "cable",
    weight: "protocolo_cuora",
    evidence: "documentado",
    notes: "Protocolo V4.0 (2010): mismo armado de trama, formato de producto propio (funciones 3 y 4)."
  },
  {
    id: "cuora_neo",
    name: "Cuora Neo",
    connection: "Ethernet / WiFi.",
    products: "archivo_ftp",
    weight: "no",
    evidence: "documentado",
    notes: "No tiene protocolo por cable: la balanza importa un archivo CSV desde un servidor FTP/SFTP. Patagonia genera el archivo."
  },
  {
    id: "croma_clipse_bumer",
    name: "Croma, Clipse, Bumer (y otras sin memoria para PC)",
    connection: "RS-232.",
    products: "no",
    weight: "protocolo_rs232",
    evidence: "documentado",
    notes: "Solo lectura de peso (4 protocolos: A, B, C Torrey, D CAS). No se les cargan productos desde la PC."
  }
];

export function systelCanWriteProducts(model: SystelModel): boolean {
  return model.products === "cable" && model.evidence === "real";
}
