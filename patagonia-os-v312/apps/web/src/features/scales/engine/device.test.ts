import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPhoneOrTablet } from "./device";

describe("celular o tablet (aviso antes de elegir el cable)", () => {
  it("tablet Android con Chrome (real Giuseppe) → sí", () => {
    assert.equal(isPhoneOrTablet({ userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X210) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", maxTouchPoints: 10 }), true);
  });
  it("celular Android, iPhone y iPad (que se presenta como Mac) → sí", () => {
    assert.equal(isPhoneOrTablet({ userAgent: "Mozilla/5.0 (Linux; Android 13) Chrome/141.0 Mobile Safari/537.36" }), true);
    assert.equal(isPhoneOrTablet({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
    assert.equal(isPhoneOrTablet({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 5 }), true);
    assert.equal(isPhoneOrTablet({ userAgent: "x", userAgentData: { mobile: true } }), true);
  });
  it("computadora con Windows, Chrome o Edge, aunque tenga pantalla táctil → no", () => {
    assert.equal(isPhoneOrTablet({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", maxTouchPoints: 10, userAgentData: { mobile: false } }), false);
    assert.equal(isPhoneOrTablet({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0", maxTouchPoints: 0 }), false);
    assert.equal(isPhoneOrTablet(null), false);
  });
});
