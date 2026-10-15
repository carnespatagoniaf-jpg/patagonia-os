import { useEffect, useState, type ReactNode } from "react";
import { Scale, X } from "lucide-react";

/**
 * Botón "Balanza" arriba a la derecha (Productos y Stock). Toda la configuración de la balanza (Mi balanza y, para
 * soporte, las herramientas técnicas) queda guardada en un panel que se abre desde acá: la pantalla queda limpia
 * (pedido del dueño, 15/10). El contenido no se monta hasta que se abre.
 */
export function ScaleButton({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button type="button" className="scale-button" onClick={() => setOpen(true)} title="Configurar la balanza">
        <Scale size={18} /> Balanza
      </button>
      {open && (
        <div className="scale-drawer-backdrop" onClick={() => setOpen(false)}>
          <aside className="scale-drawer" role="dialog" aria-label="Balanza" onClick={(e) => e.stopPropagation()}>
            <div className="scale-drawer-head">
              <strong>Balanza</strong>
              <button type="button" className="scale-drawer-close" onClick={() => setOpen(false)} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <div className="scale-drawer-body">{children}</div>
          </aside>
        </div>
      )}
    </>
  );
}
