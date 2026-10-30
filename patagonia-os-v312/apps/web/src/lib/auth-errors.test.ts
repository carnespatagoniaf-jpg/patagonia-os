import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authErrorText } from "./auth-errors";

describe("errores de inicio de sesión en castellano", () => {
  it("clave equivocada, mail sin confirmar, demasiados intentos y sin conexión", () => {
    assert.equal(authErrorText(new Error("Invalid login credentials"), "x"), "El mail o la contraseña no son correctos.");
    assert.match(authErrorText(new Error("Email not confirmed"), "x"), /confirmaste el mail/);
    assert.match(authErrorText(new Error("Request rate limit reached"), "x"), /Demasiados intentos/);
    assert.match(authErrorText(new TypeError("Failed to fetch"), "x"), /conexión a internet/);
  });
  it("contraseña nueva", () => {
    assert.equal(authErrorText(new Error("New password should be different from the old password."), "x"), "La contraseña nueva tiene que ser distinta de la anterior.");
    assert.equal(authErrorText(new Error("Password should be at least 6 characters."), "x"), "La contraseña tiene que tener al menos 6 caracteres.");
  });
  it("lo que no reconoce lo deja igual; sin mensaje usa el texto por defecto", () => {
    assert.equal(authErrorText(new Error("Perfil inválido"), "x"), "Perfil inválido");
    assert.equal(authErrorText(null, "No se pudo iniciar sesión."), "No se pudo iniciar sesión.");
  });
});
