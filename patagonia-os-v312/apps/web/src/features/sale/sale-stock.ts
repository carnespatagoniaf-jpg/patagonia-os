import type { Product } from "@patagonia/domain";

/**
 * Stock de la sucursal después de una venta, calculado en pantalla con lo que
 * se acaba de cobrar, para no volver a bajar todo el catálogo antes de dejar
 * cobrar la próxima venta. Hace lo mismo que el servidor
 * (inventory_movements_use_stock_source, migración 111): una presentación
 * descuenta del principal cantidad × factor, y el stock de cada presentación
 * es el del principal ÷ su factor (redondeado a 3 decimales, como la vista
 * products_with_stock). La recarga de fondo después pisa esto con el dato
 * real del servidor.
 */
export function applySoldToStock(products: Product[], sold: { productId?: string; quantity: number }[]): Product[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  // Cuánto sale de cada producto que tiene stock propio (principal o suelto).
  const out = new Map<string, number>();
  for (const line of sold) {
    if (!line.productId || !Number.isFinite(line.quantity) || line.quantity === 0) continue;
    const product = byId.get(line.productId);
    if (!product) continue;
    const ownerId = product.stockSourceId ?? product.id;
    const factor = product.stockSourceId ? product.stockFactor ?? 1 : 1;
    out.set(ownerId, (out.get(ownerId) ?? 0) + line.quantity * factor);
  }
  if (out.size === 0) return products;

  // Stock nuevo de cada principal: el suyo menos lo vendido.
  const ownerStock = new Map<string, number>();
  for (const [ownerId, qty] of out) {
    const owner = byId.get(ownerId);
    if (owner) ownerStock.set(ownerId, round3(owner.stock - qty));
  }

  return products.map((p) => {
    if (!p.stockSourceId) {
      const next = ownerStock.get(p.id);
      return next === undefined ? p : { ...p, stock: next };
    }
    const principal = ownerStock.get(p.stockSourceId);
    if (principal !== undefined) return { ...p, stock: round3(principal / (p.stockFactor || 1)) };
    // El principal no está en la lista (inactivo): igual se descuenta lo de esta presentación.
    const own = out.get(p.stockSourceId);
    return own === undefined ? p : { ...p, stock: round3(p.stock - own / (p.stockFactor || 1)) };
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
