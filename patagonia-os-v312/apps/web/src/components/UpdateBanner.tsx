import { useEffect, useState } from "react";

const CHECK_EVERY_MS = 5 * 60_000;

/**
 * Aviso de versión nueva (auditoría 29/10/2026): una PC con la pestaña abierta desde antes del 28/10 seguía usando
 * la web vieja y daba errores. Cada 5 minutos (y al volver a la pestaña) se mira /version.json; si la versión
 * publicada es otra, se avisa. Nunca recarga sola: en Mostrador puede haber una venta a medio cargar.
 */
export function UpdateBanner() {
  const [newVersion, setNewVersion] = useState(false);

  useEffect(() => {
    const current = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : null;
    if (!current || import.meta.env.DEV) return;
    let cancelled = false;
    async function check() {
      if (!navigator.onLine) return;
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { build?: string };
        if (!cancelled && data.build && data.build !== current) setNewVersion(true);
      } catch {
        // Sin conexión o sin version.json: no se avisa nada.
      }
    }
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!newVersion) return null;
  return (
    <div className="message warning" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>Hay una versión nueva de Patagonia. Terminá la venta que estás cargando y tocá Actualizar.</span>
      <button onClick={() => window.location.reload()}>Actualizar</button>
    </div>
  );
}
