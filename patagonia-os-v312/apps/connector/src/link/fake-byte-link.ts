// FakeByteLink: balanza simulada para las pruebas. Permite fallar al abrir,
// responder a cada escritura, colgarse (no contestar) y desconectarse a mitad.

import { BaseByteLink } from "./byte-link";

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

  constructor(options: FakeByteLinkOptions = {}) {
    super();
    this.label = options.label ?? "FAKE";
    this.respond = options.respond;
    this.replyDelayMs = options.replyDelayMs ?? 0;
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
