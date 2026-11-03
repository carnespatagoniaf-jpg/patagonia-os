/**
 * Activación guiada de la factura electrónica (2026-11-02, el dueño: "lo veo desprolijo, difícil de entender").
 * Seis pasos; los que el sistema puede ver solos (datos guardados, pedido bajado, certificado subido,
 * prueba con ARCA) se marcan solos. Los que pasan en la página de ARCA (crear el alias y bajar el .crt;
 * el permiso y el punto de venta) los marca la persona con "Ya lo hice", porque desde acá no se ven.
 */
export type ArcaStepId = "datos" | "pedido" | "arca_cert" | "subir" | "permiso" | "probar";

export const ARCA_STEPS: { id: ArcaStepId; short: string; where: "po" | "arca" }[] = [
  { id: "datos", short: "Tus datos", where: "po" },
  { id: "pedido", short: "Pedido (.csr)", where: "po" },
  { id: "arca_cert", short: "Certificado", where: "arca" },
  { id: "subir", short: "Subirlo", where: "po" },
  { id: "permiso", short: "Permiso y PV", where: "arca" },
  { id: "probar", short: "Probar", where: "po" }
];

export interface ArcaSetupState {
  hasSettings: boolean;
  enabled: boolean;
  /** Factura con el certificado de Patagonia OS (mismo CUIT): no hace falta pedido ni certificado propio. */
  usesShared: boolean;
  hasRequest: boolean;
  hasCertificate: boolean;
  /** Marcados a mano por la persona (pasos que pasan en ARCA). */
  ackArcaCert: boolean;
  ackPermission: boolean;
}

export function arcaStepDone(id: ArcaStepId, s: ArcaSetupState): boolean {
  if (s.enabled) return true;
  switch (id) {
    case "datos":
      return s.hasSettings;
    case "pedido":
      return s.usesShared || s.hasRequest || s.hasCertificate;
    case "arca_cert":
      return s.usesShared || s.hasCertificate || s.ackArcaCert;
    case "subir":
      return s.usesShared || s.hasCertificate;
    case "permiso":
      return s.ackPermission;
    case "probar":
      return false;
  }
}

/** El primer paso que falta (o "probar" si están todos). */
export function currentArcaStep(s: ArcaSetupState): ArcaStepId {
  return ARCA_STEPS.find((step) => !arcaStepDone(step.id, s))?.id ?? "probar";
}
