/**
 * Puerto serie simulado para los tests de la balanza de peso (no se usa en
 * la app real; los tests están excluidos de tsc). Cuando le piden el peso
 * ("W") contesta con los pedazos de `reply`, cada uno después de su demora,
 * como llega de verdad por el cable.
 */
export class FakeWeightPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0;
  constructor(private reply: Array<[delayMs: number, text: string]> = []) {}
  async open() {
    this.opens++;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = this.reply;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (chunk[0] !== 0x57) return;
        for (const [delay, text] of reply) {
          setTimeout(() => {
            try {
              controller.enqueue(new TextEncoder().encode(text));
            } catch {
              // puerto ya cerrado
            }
          }, delay);
        }
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}
