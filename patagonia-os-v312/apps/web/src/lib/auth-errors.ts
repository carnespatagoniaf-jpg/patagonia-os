/**
 * Errores de inicio de sesión y de contraseña en castellano (auditoría 29/10/2026: lo primero que veía un cliente
 * que se equivocaba de clave era "Invalid login credentials"). Lo que no se reconoce se muestra tal cual.
 */
const RULES: Array<[RegExp, string]> = [
  [/invalid login credentials|invalid_grant/i, "El mail o la contraseña no son correctos."],
  [/email not confirmed/i, "Todavía no confirmaste el mail. Revisá tu correo (también el spam)."],
  [/too many requests|rate limit|over_request_rate_limit|for security purposes/i, "Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo."],
  [/failed to fetch|networkerror|network request failed|load failed/i, "No hay conexión a internet. Revisá la conexión y probá de nuevo."],
  [/new password should be different/i, "La contraseña nueva tiene que ser distinta de la anterior."],
  [/password should be at least (\d+)/i, "La contraseña tiene que tener al menos $1 caracteres."],
  [/user not found/i, "No hay ningún usuario con ese mail."],
  [/user (is )?banned/i, "Ese usuario está dado de baja. Hablá con el dueño del negocio."],
  [/jwt expired|session.*(expired|not found)|refresh token/i, "La sesión venció. Volvé a entrar."]
];

export function authErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return fallback;
  for (const [pattern, text] of RULES) {
    const match = message.match(pattern);
    if (match) return text.replace("$1", match[1] ?? "");
  }
  return message;
}
