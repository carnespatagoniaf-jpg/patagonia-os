import { kretzChecksum } from "./kretz-frame";

/**
 * "Aura de mentira" para CAPTURAR lo que manda iTegra / JDataGate, sin la
 * balanza de la clienta. No se usa en la app: la usa scripts/aura-captura.ts
 * (servidor TCP local) para hacerse pasar por la Aura y registrar byte por
 * byte cada comando.
 *
 * Contesta como contestó la Aura REAL ("Pollo y mar", 2026-10-01/02):
 * - 0001 → grupo 00, código 01.
 * - 1500 → los datos técnicos reales.
 * - 5005 → el siguiente PLU mayor, de su propia memoria (arranca con los 6 reales). Al final, código 40.
 * - 2005 → guarda el registro TAL CUAL llega y contesta grupo 05, código 01.
 *   Así se ve exactamente qué manda iTegra, sin que esta "balanza" lo cambie.
 * - Configuración (1000-1499), otras altas (2xxx) y bajas (3xxx/4xxx) → "01" sin
 *   aplicar nada: así iTegra no se corta y se ve todo lo que manda.
 * - Cualquier otra lectura → grupo 00, código 02 ("comando inexistente"), como
 *   contestó la real a 0002 y a 5002. Todo queda registrado.
 */

export const REAL_1500_DATA = "AUI-030KMFBAPP4KAR  V1.00  6Feb24 00       ";
export const REAL_CLIENT_RECORDS = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000"
];

export interface CaptureEntry {
  at: string;
  rxHex: string;
  rxAscii: string;
  /** Trama Kretz entendida (si tenía forma de trama). */
  frame: { deviceType: string; equipmentId: string; command: string; data: string; checksumOk: boolean } | null;
  txHex: string;
  note: string;
}

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (b: number[]) => b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");

export class FakeAuraDevice {
  records: string[];
  log: CaptureEntry[] = [];
  private buffer: number[] = [];
  constructor(records: string[] = REAL_CLIENT_RECORDS, private deviceType = "H", private equipmentId = "01") {
    this.records = [...records];
  }

  private reply(group: string, code: string, data = ""): number[] {
    const body = [0x07, ...Array.from(this.deviceType + this.equipmentId + group + code + data, (c) => c.charCodeAt(0))];
    return [...body, ...kretzChecksum(body), 0x04];
  }

  /** Recibe bytes (pueden llegar en pedazos). Devuelve lo que hay que contestar. */
  receive(chunk: Uint8Array | number[]): number[] {
    this.buffer.push(...chunk);
    const out: number[] = [];
    for (;;) {
      const start = this.buffer.indexOf(0x02);
      if (start < 0) {
        if (this.buffer.length) this.logRaw(this.buffer.splice(0), "bytes sueltos (sin STX)");
        break;
      }
      if (start > 0) this.logRaw(this.buffer.splice(0, start), "bytes antes del STX");
      const end = this.buffer.indexOf(0x04);
      if (end < 0) break; // falta el resto de la trama
      const frame = this.buffer.splice(0, end + 1);
      out.push(...this.handle(frame));
    }
    return out;
  }

  private logRaw(bytes: number[], note: string) {
    this.log.push({ at: new Date().toISOString(), rxHex: hex(bytes), rxAscii: ascii(bytes), frame: null, txHex: "", note });
  }

  private handle(frame: number[]): number[] {
    const text = String.fromCharCode(...frame);
    const deviceType = text[1];
    const equipmentId = text.slice(2, 4);
    const command = text.slice(4, 8);
    const data = text.slice(8, -3);
    const sum = kretzChecksum(frame.slice(0, -3));
    const checksumOk = sum[0] === frame[frame.length - 3] && sum[1] === frame[frame.length - 2];
    let tx: number[];
    let note: string;
    if (!checksumOk) {
      tx = this.reply("00", "10");
      note = "checksum incorrecto";
    } else if (command === "0001") {
      tx = this.reply("00", "01");
      note = "test de conexión";
    } else if (command === "1500") {
      tx = this.reply("00", "01", REAL_1500_DATA);
      note = "datos técnicos";
    } else if (command === "5005") {
      const next = [...this.records].sort().find((r) => Number(r.slice(0, 6)) > Number(data));
      tx = next ? this.reply("05", "01", next) : this.reply("05", "40");
      note = `lectura de PLU (siguiente a ${data})`;
    } else if (command === "2005") {
      this.records = this.records.filter((r) => r.slice(0, 6) !== data.slice(0, 6)).concat(data);
      tx = this.reply("05", "01");
      note = `ALTA/MODIFICACIÓN DE PLU: ${data.length} caracteres`;
    } else if (/^(1[0-4][0-9][0-9]|[234][0-9][0-9][0-9])$/.test(command)) {
      // Configuración (1000-1499), altas (2xxx) y bajas (3xxx/4xxx) distintas de 2005: se contesta OK
      // para que iTegra siga y se vea TODO lo que manda. No se aplica nada (solo se registra).
      tx = this.reply(command.startsWith("1") ? "00" : command.slice(2, 4), "01");
      note = `comando ${command} (contestado OK sin aplicar, solo registrado)`;
    } else {
      tx = this.reply("00", "02");
      note = `comando ${command} (contestado "inexistente")`;
    }
    this.log.push({ at: new Date().toISOString(), rxHex: hex(frame), rxAscii: ascii(frame), frame: { deviceType, equipmentId, command, data, checksumOk }, txHex: hex(tx), note });
    return tx;
  }
}
