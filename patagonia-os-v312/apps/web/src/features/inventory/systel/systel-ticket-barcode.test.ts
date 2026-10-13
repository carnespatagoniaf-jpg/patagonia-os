import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSystelFunctionAllowed, SystelClient, type SystelExchangeOptions, type SystelLink } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { parseSystelReply } from "./systel-frame";
import { hexToBytes, SESSION_OK_1608 } from "./systel-real-captures";
import { enableTicketBarcodes } from "./systel-ticket-barcode";

/**
 * [REAL] la configuración de partida es la que devolvió la balanza de Los gringos (2026-10-09),
 * con "ETi=N". [SINTÉTICO] cómo responde la balanza a la función 7: simulador hecho con el documento
 * (igual en V4.0/V6.0/V6.2/V7). Nunca se probó en una balanza real.
 */
const REAL_CONFIG = parseSystelReply(hexToBytes(SESSION_OK_1608.find((x) => x.tx === "14 27 33")!.rx))!.data;

function scale() {
  const f = new FakeCuora("max60", { address: 20 });
  f.config = REAL_CONFIG;
  return f;
}
const client = (link: SystelLink, writes = true) => new SystelClient(link, { address: 20, writes: { ticketBarcodes: writes }, busyRetryMs: [] });
const sent = (f: FakeCuora) => f.received.map((r) => `${r.fn}${r.data ? `:${r.data}` : ""}`);

describe("activar el código de cada producto en el ticket (función 7)", () => {
  it("[REAL] la configuración de Los gringos tiene ETi=N (por eso el ticket sale con el código en blanco)", () => {
    assert.match(REAL_CONFIG, /;ETi=N$/);
  });

  it("lee, manda UNA orden 7 'XS', relee: cambió solo ETi de N a S → activado", async () => {
    const f = scale();
    const r = await enableTicketBarcodes(client(f));
    assert.equal(r.outcome, "activado", r.detail);
    assert.deepEqual(r.changed, ["ETi"]);
    assert.deepEqual(sent(f), ["39", "7:XS", "39"]);
    assert.equal(f.config, REAL_CONFIG.replace("ETi=N", "ETi=S"));
  });

  it("si ya está activado, no manda nada", async () => {
    const f = scale();
    f.config = REAL_CONFIG.replace("ETi=N", "ETi=S");
    const r = await enableTicketBarcodes(client(f));
    assert.equal(r.outcome, "ya_activado");
    assert.deepEqual(sent(f), ["39"]);
  });

  it("si la balanza no informa esa opción, no manda nada (no se podría comprobar)", async () => {
    const f = new FakeCuora("max60", { address: 20 }); // configuración de ejemplo, sin "ETi"
    const r = await enableTicketBarcodes(client(f));
    assert.equal(r.outcome, "no_soportado");
    assert.ok(!sent(f).some((s) => s.startsWith("7")));
  });

  it("si no puede leer la configuración, no manda nada", async () => {
    const f = scale();
    f.silent = true;
    const r = await enableTicketBarcodes(client(f));
    assert.equal(r.outcome, "sin_lectura");
    assert.ok(!sent(f).some((s) => s.startsWith("7")));
  });

  it("contesta ACK pero no cambia: 'sin cambios', no se da por bueno", async () => {
    const f = scale();
    f.ignoreConfig = true;
    const r = await enableTicketBarcodes(client(f));
    assert.equal(r.outcome, "sin_cambios");
    assert.equal(r.ok, false);
  });

  it("si cambia algo más que lo pedido: 'diferencia', se informa qué", async () => {
    const f = scale();
    f.alsoTouch = ["Ton", "4"];
    const r = await enableTicketBarcodes(client(f));
    assert.equal(r.outcome, "diferencia");
    assert.match(r.detail, /Ton 2→4/);
  });

  it("sin respuesta a la orden pero la relectura muestra el cambio: INDETERMINADO (no se cuenta como hecho)", async () => {
    const f = scale();
    const quietOn7: SystelLink = { exchange: async (frame: Uint8Array, o: SystelExchangeOptions) => { const r = await f.exchange(frame); return frame[1] === 7 ? null : r; } };
    const r = await enableTicketBarcodes(client(quietOn7));
    assert.equal(r.outcome, "indeterminado");
    assert.equal(r.ok, false);
    assert.equal(sent(f).filter((s) => s.startsWith("7")).length, 1, "no reenvía");
  });

  it("si la balanza contesta error (E3) a la orden: no se reintenta y queda 'rechazado'", async () => {
    const f = scale();
    let n = 0;
    const e3On7: SystelLink = { exchange: async (frame: Uint8Array) => { n += 1; if (frame[1] === 7) { f.received.push({ fn: 7, data: "XS" }); const body = [20, 7, 0x45, 0x33]; return Uint8Array.from([...body, body.reduce((a, b) => a ^ b, 0)]); } return f.exchange(frame); } };
    const r = await enableTicketBarcodes(client(e3On7));
    assert.equal(r.outcome, "rechazado");
    assert.equal(sent(f).filter((s) => s.startsWith("7")).length, 1);
    assert.ok(n >= 3);
  });

  it("sin permiso de escritura, bloqueado y sin mandar la 7", async () => {
    const f = scale();
    const r = await enableTicketBarcodes(client(f, false));
    assert.equal(r.outcome, "bloqueado");
    assert.ok(!sent(f).some((s) => s.startsWith("7")));
  });

  it("la función 7 no se puede mandar por fuera de su método", () => {
    assert.throws(() => assertSystelFunctionAllowed(7));
  });
});
