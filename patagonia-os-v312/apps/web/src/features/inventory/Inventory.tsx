import { demoProducts } from "../../lib/demo-data";

export function Inventory() {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">INVENTARIO</p>
          <h1>Stock de Haedo</h1>
          <p className="muted">Base visual conectable a la vista current_stock de Supabase.</p>
        </div>
      </header>
      <section className="panel">
        <table className="data-table">
          <thead>
            <tr><th>Código</th><th>Producto</th><th>Stock</th><th>Mínimo</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {demoProducts.map((product) => (
              <tr key={product.id}>
                <td>{product.code}</td>
                <td>{product.name}</td>
                <td>{product.stock} {product.unit}</td>
                <td>{product.minStock}</td>
                <td>{product.stock <= product.minStock ? "Atención" : "Correcto"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
