import { useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { getBranchZone, listProductListPrices } from "./price-lists-service";

/**
 * Precios de la zona del local (plan Empresa, migración 192), para lo que muestra o manda el precio de venta:
 * Productos (consulta y cartel), la balanza de ese local. Sin zona, devuelve el precio de siempre.
 * Stock sigue mostrando y editando el precio general.
 */
export function useBranchZone(branchId: string | null | undefined) {
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [prices, setPrices] = useState<Map<string, Record<string, { price: number; manual: boolean }>>>(new Map());

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    let cancelled = false;
    void getBranchZone(branchId)
      .then(async (z) => {
        if (cancelled) return;
        setZoneId(z);
        if (z) {
          const map = await listProductListPrices();
          if (!cancelled) setPrices(map);
        }
      })
      .catch(() => !cancelled && setZoneId(null));
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  /** Precio de venta en este local. */
  function price(productId: string, general: number): number {
    if (!zoneId) return general;
    return prices.get(productId)?.[zoneId]?.price ?? general;
  }

  /** La misma lista con el precio de venta de este local en priceRetail (para la balanza o el cartel). */
  function withZonePrices<T extends { id: string; priceRetail: number }>(list: T[]): T[] {
    return zoneId ? list.map((p) => ({ ...p, priceRetail: price(p.id, p.priceRetail) })) : list;
  }

  return { zoneId, price, withZonePrices };
}
