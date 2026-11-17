import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CableToDrawing, JackDrawing, ScaleDrawing } from "./NetDrawings";
import { netBrand, type NetBrandId } from "./net-wizard";

/**
 * La hoja para dejar pegada al lado de la balanza: una página por marca, con los mismos pasos del asistente y la ruta
 * del menú de ESA balanza para ver y cambiar la dirección (IP).
 */

/** Las marcas que se conectan por red (las que tienen hoja). */
export const SHEET_BRANDS: NetBrandId[] = ["kretz-report", "systel-cuora-max"];

export function NetScalePage({ brand, ip }: { brand: NetBrandId; ip?: string | null }) {
  const b = netBrand(brand);
  return (
    <article className="net-sheet-page">
      <header className="net-sheet-head">
        <ScaleDrawing brand={brand} size={110} />
        <div>
          <h1>{b.label}</h1>
          <p>Cómo conectarla a Patagonia por cable de red</p>
          {ip && <p className="net-sheet-ip">Dirección de esta balanza: <strong>{ip}</strong></p>}
        </div>
      </header>
      <ol className="net-sheet-steps">
        <li>
          <strong>Enchufá el cable</strong> en la balanza (atrás, abajo) y la otra punta en el router o módem del local, o en la computadora.
          <div className="net-sheet-art">
            <CableToDrawing to="router" size={200} />
            <CableToDrawing to="pc" size={200} />
          </div>
        </li>
        <li>
          <strong>Mirá la luz al lado del cable:</strong> tiene que estar prendida. Si está apagada, sacá el cable y volvé a ponerlo hasta que haga clic. Si sigue apagada, probá con otro cable.
          <div className="net-sheet-art">
            <JackDrawing lit size={160} />
            <JackDrawing lit={false} size={160} />
          </div>
        </li>
        <li>
          <strong>Prendé la balanza</strong> y esperá a que muestre el peso en cero.
        </li>
        <li>
          <strong>En Patagonia:</strong> Productos → botón "Balanza" → Mis balanzas → Agregar balanza → <em>Conectar balanza por cable de red</em> → BUSCAR.
        </li>
      </ol>
      {b.menu && (
        <section className="net-sheet-box">
          <h2>Ver o cambiar la dirección (IP) de la balanza</h2>
          <p>{b.menu.path}</p>
          <p>{b.menu.fixed}</p>
          <p>Si dos balanzas tienen la misma dirección, ninguna anda bien: cada una la suya.</p>
        </section>
      )}
      <section className="net-sheet-box">
        <h2>Si mañana no la encuentra</h2>
        <p>1) Luz del cable prendida. 2) Balanza prendida. 3) En Mis balanzas, tocá PASAR PRODUCTOS; si no conecta, BUSCAR DE NUEVO EN LA RED.</p>
        <p>Si nada de eso anda, en el asistente tocá "Mandar diagnóstico a soporte" y avisanos por WhatsApp.</p>
      </section>
    </article>
  );
}

/** Imprime las hojas pedidas sin tocar el resto de la pantalla (portal + .print-area, como el Remito R). */
export function NetScaleSheetPrint({ brands, ip, onDone }: { brands: NetBrandId[]; ip?: string | null; onDone: () => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const t = window.setTimeout(() => {
      window.print();
      doneRef.current();
    }, 50);
    return () => window.clearTimeout(t);
  }, [brands]);
  return createPortal(
    <div className="print-area net-sheet-print">
      {brands.map((b) => (
        <NetScalePage key={b} brand={b} ip={brands.length === 1 ? ip : null} />
      ))}
    </div>,
    document.body
  );
}
