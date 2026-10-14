import { useEffect, useState, type ReactNode } from "react";
import { Wrench } from "lucide-react";
import { fetchScaleSupportEnabled } from "./support-access";

/**
 * "Herramientas técnicas de balanza": diagnósticos, puertos, velocidades, respaldos, restauraciones, escritura
 * experimental. Nada de esto se borró: está acá, cerrado, y SOLO aparece si la base lo permite
 * (`scale_support_tools_enabled`, migración 120): administradores de la plataforma, o una empresa con el acceso de
 * soporte abierto por un administrador durante unas horas. Para el cliente no existe.
 */
export function ScaleSupportTools({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchScaleSupportEnabled().then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, []);

  if (!enabled) return null;
  return (
    <details className="my-scale-support">
      <summary>
        <Wrench size={16} /> Herramientas técnicas de balanza <span className="muted">(solo soporte de Patagonia)</span>
      </summary>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>{children}</div>
    </details>
  );
}
