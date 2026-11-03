import { useActiveBranch } from "../branches/BranchProvider";
import { Transfers } from "./Transfers";

/** "Entre locales": la pantalla del encargado, el cajero y producción, siempre sobre su local. El dueño y el
 * administrador usan la pestaña "Mercadería entre locales" de Sucursales. */
export function TransfersPage() {
  const { activeBranch } = useActiveBranch();
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">ENTRE LOCALES</p>
          <h1>Mercadería entre locales</h1>
          <p className="muted">Pedí lo que te falta, prepará lo que te piden y controlá lo que llega{activeBranch ? ` a ${activeBranch.name}` : ""}.</p>
        </div>
      </header>
      <Transfers admin={false} />
    </>
  );
}
