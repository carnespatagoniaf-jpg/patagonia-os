import type { NetBrandId } from "./net-wizard";

/**
 * Dibujos simples para el asistente y la hoja imprimible. Son dibujos (no fotos de la marca): muestran lo que hay que
 * mirar — el conector de red con su luz, adónde va el cable — sin depender de fotos de cada modelo.
 */

const INK = "#18202b";
const SOFT = "#e5e7eb";
const ACCENT = "#8b1e1e";

/** La balanza de frente, con el nombre que se ve en la pantalla. */
export function ScaleDrawing({ brand, size = 120 }: { brand: NetBrandId; size?: number }) {
  const text = brand === "kretz-report" ? "REPORT" : brand === "systel-cuora-max" ? "CUORA MAX" : brand === "kretz-aura" ? "AURA" : brand === "systel-cuora-neo" ? "NEO" : "?";
  const touch = brand === "systel-cuora-neo";
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 160 120" role="img" aria-label={`Dibujo de balanza ${text}`}>
      <rect x="20" y="8" width="120" height="44" rx="8" fill={INK} />
      <rect x="30" y="16" width={touch ? 100 : 70} height="28" rx="4" fill={touch ? "#c9e3ff" : "#bfe1f6"} />
      {!touch && <text x="65" y="35" textAnchor="middle" fontSize="11" fontWeight="700" fill={INK} fontFamily="system-ui, sans-serif">0,000</text>}
      <text x="80" y={touch ? 34 : 13.5} textAnchor="middle" fontSize={touch ? 12 : 7} fontWeight="700" fill={touch ? INK : "#9ae6b4"} fontFamily="system-ui, sans-serif">{text}</text>
      {!touch && <rect x="106" y="18" width="26" height="24" rx="3" fill="#2b3442" />}
      <rect x="74" y="52" width="12" height="18" fill="#9aa3af" />
      <rect x="12" y="70" width="136" height="14" rx="4" fill="#cfd4dc" />
      <rect x="8" y="84" width="144" height="26" rx="6" fill={SOFT} stroke="#c3c8d1" />
    </svg>
  );
}

/** El conector de red: luz prendida (bien) o apagada (cable flojo o roto). */
export function JackDrawing({ lit, size = 220 }: { lit: boolean; size?: number }) {
  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 200 124" role="img" aria-label={lit ? "Conector de red con la luz prendida" : "Conector de red con la luz apagada"}>
      <rect x="20" y="20" width="160" height="80" rx="10" fill="#f3f4f6" stroke="#c3c8d1" />
      <rect x="60" y="40" width="80" height="50" rx="4" fill={INK} />
      <rect x="72" y="48" width="56" height="10" fill="#4b5563" />
      <rect x="88" y="78" width="24" height="12" fill="#f3f4f6" />
      <circle cx="44" cy="48" r="9" fill={lit ? "#f5b400" : "#9ca3af"} stroke={lit ? "#c98a00" : "#6b7280"} />
      {lit && <circle cx="44" cy="48" r="15" fill="none" stroke="#f5b400" strokeWidth="2" opacity=".5" />}
      <circle cx="156" cy="48" r="9" fill={lit ? "#22c55e" : "#9ca3af"} stroke={lit ? "#15803d" : "#6b7280"} />
      <text x="100" y="116" textAnchor="middle" fontSize="13" fill={INK} fontFamily="system-ui, sans-serif">{lit ? "Luz prendida: bien" : "Luz apagada: cable flojo o roto"}</text>
    </svg>
  );
}

/** Adónde va la otra punta del cable: a la computadora o al router (la cajita de internet). */
export function CableToDrawing({ to, size = 220 }: { to: "pc" | "router"; size?: number }) {
  return (
    <svg width={size} height={size * 0.5} viewBox="0 0 240 120" role="img" aria-label={to === "pc" ? "Cable de la balanza a la computadora" : "Cable de la balanza al router"}>
      <rect x="6" y="40" width="60" height="22" rx="4" fill={INK} />
      <rect x="2" y="70" width="70" height="20" rx="4" fill={SOFT} stroke="#c3c8d1" />
      <text x="37" y="108" textAnchor="middle" fontSize="11" fill={INK} fontFamily="system-ui, sans-serif">balanza</text>
      <path d="M72 80 C 110 80, 130 60, 168 60" stroke={ACCENT} strokeWidth="4" fill="none" />
      {to === "pc" ? (
        <g>
          <rect x="168" y="20" width="64" height="44" rx="4" fill={INK} />
          <rect x="174" y="26" width="52" height="32" fill="#bfe1f6" />
          <rect x="194" y="64" width="12" height="10" fill="#9aa3af" />
          <rect x="182" y="74" width="36" height="6" rx="2" fill="#9aa3af" />
          <text x="200" y="108" textAnchor="middle" fontSize="11" fill={INK} fontFamily="system-ui, sans-serif">computadora</text>
        </g>
      ) : (
        <g>
          <rect x="166" y="48" width="70" height="26" rx="6" fill="#2b3442" />
          <circle cx="180" cy="61" r="3" fill="#22c55e" />
          <circle cx="192" cy="61" r="3" fill="#22c55e" />
          <circle cx="204" cy="61" r="3" fill="#f5b400" />
          <line x1="178" y1="48" x2="172" y2="26" stroke="#2b3442" strokeWidth="3" />
          <line x1="224" y1="48" x2="230" y2="26" stroke="#2b3442" strokeWidth="3" />
          <text x="200" y="108" textAnchor="middle" fontSize="11" fill={INK} fontFamily="system-ui, sans-serif">router / módem</text>
        </g>
      )}
    </svg>
  );
}
