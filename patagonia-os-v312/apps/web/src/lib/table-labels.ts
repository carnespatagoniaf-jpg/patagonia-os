/**
 * En el celular cada tabla se muestra como tarjetas (una por fila; ver
 * styles.css, "tablas como tarjetas"). Para que cada dato diga qué es, cada
 * celda lleva data-label con el título de su columna. Se hace acá, en un solo
 * lugar, en vez de tocar cada tabla de cada pantalla.
 */

/** Título de cada columna, teniendo en cuenta colSpan. */
export function columnTitles(headerCells: { text: string; span: number }[]): string[] {
  const titles: string[] = [];
  for (const cell of headerCells) {
    for (let i = 0; i < Math.max(1, cell.span); i++) titles.push(cell.text);
  }
  return titles;
}

function labelTable(table: HTMLTableElement) {
  const headRow = table.tHead?.rows[0];
  if (!headRow) return;
  const titles = columnTitles([...headRow.cells].map((c) => ({ text: (c.textContent ?? "").trim(), span: c.colSpan })));
  for (const body of [...table.tBodies]) {
    for (const row of [...body.rows]) {
      let col = 0;
      for (const cell of [...row.cells]) {
        const label = cell.colSpan > 1 ? "" : titles[col] ?? "";
        if (label) {
          if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
        } else if (cell.hasAttribute("data-label")) {
          cell.removeAttribute("data-label");
        }
        col += Math.max(1, cell.colSpan);
      }
    }
  }
}

export function installTableLabels() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  let pending = false;
  const run = () => {
    pending = false;
    document.querySelectorAll<HTMLTableElement>("table.data-table").forEach(labelTable);
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    // setTimeout y no requestAnimationFrame: rAF se frena en pestañas en segundo plano.
    setTimeout(run, 60);
  };
  // Solo cambios de estructura (filas/celdas nuevas): los atributos que pone este mismo código no lo vuelven a disparar.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}
