import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escposToText } from "./scale-listen";

const bytes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("[PURO] escuchar la balanza: ESC/POS → texto", () => {
  it("un ticket de texto se lee renglón por renglón (sin los comandos de formato)", () => {
    const ticket = [0x1b, 0x40, ...bytes("KRETZ S.A.\r\nCOSTELETAS\n0.245kg @ 15900$/kg\n"), 0x1d, 0x21, 0x11, ...bytes("TOTAL = 3895$\n")];
    const r = escposToText(ticket);
    assert.equal(r.raster, false);
    assert.match(r.text, /KRETZ S\.A\.\nCOSTELETAS\n0\.245kg @ 15900\$\/kg\n/);
    assert.match(r.text, /TOTAL = 3895\$/);
  });

  it("si el ticket viene como imagen (GS v 0), se avisa", () => {
    assert.equal(escposToText([0x1d, 0x76, 0x30, 0x00, 0x10, 0x00]).raster, true);
  });
});
