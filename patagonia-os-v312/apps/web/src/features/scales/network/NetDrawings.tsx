/** El conector de red con su luz: lo único que hay que mirar en la balanza cuando no aparece. */
export function JackDrawing({ lit, size = 220 }: { lit: boolean; size?: number }) {
  const ink = "#18202b";
  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 200 124" role="img" aria-label={lit ? "Conector de red con la luz prendida" : "Conector de red con la luz apagada"}>
      <rect x="20" y="20" width="160" height="80" rx="10" fill="#f3f4f6" stroke="#c3c8d1" />
      <rect x="60" y="40" width="80" height="50" rx="4" fill={ink} />
      <rect x="72" y="48" width="56" height="10" fill="#4b5563" />
      <rect x="88" y="78" width="24" height="12" fill="#f3f4f6" />
      <circle cx="44" cy="48" r="9" fill={lit ? "#f5b400" : "#9ca3af"} stroke={lit ? "#c98a00" : "#6b7280"} />
      {lit && <circle cx="44" cy="48" r="15" fill="none" stroke="#f5b400" strokeWidth="2" opacity=".5" />}
      <circle cx="156" cy="48" r="9" fill={lit ? "#22c55e" : "#9ca3af"} stroke={lit ? "#15803d" : "#6b7280"} />
      <text x="100" y="116" textAnchor="middle" fontSize="13" fill={ink} fontFamily="system-ui, sans-serif">{lit ? "Así: luz prendida" : "Luz apagada: cable flojo o roto"}</text>
    </svg>
  );
}
