import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectAndRelease } from "./serial-tabs";

function port(open: boolean, locked = false) {
  const p = {
    closed: false,
    readable: open ? { locked } : null,
    writable: open ? { locked: false } : null,
    async close() {
      if (locked) throw new Error("locked");
      p.closed = true;
      p.readable = null;
      p.writable = null;
    }
  };
  return p;
}

describe("otras pestañas con la balanza tomada", () => {
  it("cuenta los puertos abiertos sin tocarlos cuando solo se pregunta", async () => {
    const a = port(true);
    const r = await inspectAndRelease([a, port(false)], false);
    assert.deepEqual(r, { openPorts: 1, released: 0, busy: 0 });
    assert.equal(a.closed, false);
  });

  it("suelta los que no están en uso y no toca uno que se está usando", async () => {
    const idle = port(true);
    const inUse = port(true, true);
    const r = await inspectAndRelease([idle, inUse], true);
    assert.deepEqual(r, { openPorts: 2, released: 1, busy: 1 });
    assert.equal(idle.closed, true);
    assert.equal(inUse.closed, false);
  });
});
