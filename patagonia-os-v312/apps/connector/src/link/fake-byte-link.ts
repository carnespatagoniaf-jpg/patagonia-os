// FakeByteLink: balanza simulada para las pruebas. Permite fallar al abrir,
// responder a cada escritura, colgarse (no contestar) y desconectarse a mitad.

import { BaseByteLink, sameLineSettings, type LineSettings, type LineSignals } from "./byte-link";

export type FakeResponder = (
  written: Uint8Array,
  link: FakeByteLink,
) => Uint8Array | string | null | undefined;

export interface FakeByteLinkOptions {
  label?: string;
  /** Qué contestar a cada escritura (null/undefined = nada). */
  respond?: FakeResponder;
  /** Demora de la respuesta, en ms. */
  replyDelayMs?: number;
  /**
   * Si está, simula un puerto SERIE: se puede reconfigurar (velocidad, bits) y
   * cambiar señales, como SerialByteLink. Sin esto se comporta como TCP.
   */
  lineSettings?: LineSettings;
  /** Fabricante y producto del adaptador USB simulado. */
  usbInfo?: { usbVendorId?: number; usbProductId?: number };
}

export class FakeByteLink extends BaseByteLink {
  readonly label: string;
  readonly writes: Uint8Array[] = [];
  openCount = 0;
  closeCount = 0;
  /** Si está, el próximo open() falla con este error (y se borra). */
  nextOpenError: unknown = null;
  /** Si es una función, se consulta en cada open() (útil para "falla N veces"). */
  openErrorFor: ((attempt: number) => unknown) | null = null;
  /** Colgada: recibe las escrituras pero nunca contesta. */
  hung = false;
  respond: FakeResponder | undefined;
  replyDelayMs: number;
  /** Puerto serie simulado: configuración actual (null = enlace de red). */
  currentSettings: LineSettings | null;
  readonly usbInfo?: { usbVendorId?: number; usbProductId?: number };
  readonly reconfigurations: LineSettings[] = [];
  readonly signals: LineSignals[] = [];

  constructor(options: FakeByteLinkOptions = {}) {
    super();
    this.label = options.label ?? "FAKE";
    this.respond = options.respond;
    this.replyDelayMs = options.replyDelayMs ?? 0;
    this.currentSettings = options.lineSettings ?? null;
    this.usbInfo = options.usbInfo;
  }

  /** null = enlace "de red", sin control de línea (isSerialLineControl da false). */
  get lineSettings(): LineSettings | null {
    return this.currentSettings;
  }

  async reconfigure(next: LineSettings): Promise<void> {
    if (this.isOpen && this.currentSettings && sameLineSettings(this.currentSettings, next)) return;
    await this.reopen(() => {
      this.currentSettings = { ...next };
      this.reconfigurations.push({ ...next });
    });
  }

  async setSignals(signals: LineSignals): Promise<void> {
    this.signals.push({ ...signals });
  }

  protected async doOpen(): Promise<void> {
    this.openCount += 1;
    const planned = this.openErrorFor?.(this.openCount) ?? null;
    const error = this.nextOpenError ?? planned;
    this.nextOpenError = null;
    if (error) throw error;
  }

  protected async doWrite(data: Uint8Array): Promise<void> {
    this.writes.push(new Uint8Array(data));
    if (this.hung || !this.respond) return;
    const reply = this.respond(data, this);
    if (reply === null || reply === undefined) return;
    const bytes = typeof reply === "string" ? Buffer.from(reply, "latin1") : reply;
    setTimeout(() => this.inject(bytes), this.replyDelayMs);
  }

  protected async doClose(): Promise<void> {
    this.closeCount += 1;
  }

  /** Simula bytes que llegan desde la balanza. */
  inject(data: Uint8Array | string): void {
    this.receive(typeof data === "string" ? Buffer.from(data, "latin1") : data);
  }

  /** Simula que se desenchufa el cable o se apaga la balanza. */
  simulateDisconnect(reason = "cable desenchufado"): void {
    this.lost(new Error(reason));
  }
}
