import type { Page } from "../auth/permissions";

export interface OnboardingStatus {
  products: number;
  stockLoaded: boolean;
  sales: number;
  /** Ventas a cuenta (Clientes, Venta en ruta): también cuentan como que ya vende. */
  accountSales: number;
  closedShifts: number;
  /** ¿Usa Mostrador? (La primera vende solo en ruta: sin pasos de caja). */
  usesPos: boolean;
}

export interface OnboardingStep {
  key: "productos" | "stock" | "venta" | "cierre";
  title: string;
  help: string;
  done: boolean;
  page: Page;
  action: string;
}

/** Productos mínimos para dar por hecho el paso 1 (una carnicería real tiene decenas). */
export const MIN_PRODUCTS = 5;

/**
 * Los 4 pasos para empezar a usar Patagonia (auditoría 29/10/2026: 10 de 44 clientes activos sin productos, 29 sin
 * ventas en una semana). Lógica pura, testeada. Todos hechos = la tarjeta no se muestra.
 */
export function onboardingSteps(s: OnboardingStatus): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    {
      key: "productos",
      title: "Cargá tus productos",
      help: "Uno por uno en Stock, todos juntos desde un Excel en Importar, o traelos de tu balanza.",
      done: s.products >= MIN_PRODUCTS,
      page: "inventory",
      action: "Ir a Stock"
    },
    {
      key: "stock",
      title: "Poné el stock que tenés hoy",
      help: "En Stock, tocá Ajustar en cada producto y escribí lo que contaste. O cargá tu primera compra.",
      done: s.stockLoaded,
      page: "inventory",
      action: "Ir a Stock"
    },
    {
      key: "venta",
      title: "Hacé tu primera venta",
      help: "En Mostrador abrí la caja, buscá un producto y cobralo.",
      done: s.sales > 0 || s.accountSales > 0,
      page: "sale",
      action: "Ir a Mostrador"
    },
    {
      key: "cierre",
      title: "Cerrá la caja al terminar el día",
      help: "En Mostrador, Cerrar caja: contás la plata y el sistema te dice si da bien.",
      // Si vende solo a cuenta (sin Mostrador), no hay caja que cerrar.
      done: s.closedShifts > 0 || (s.sales === 0 && s.accountSales > 0),
      page: "sale",
      action: "Ir a Mostrador"
    }
  ];
  return s.usesPos ? steps : steps.filter((x) => x.key !== "venta" && x.key !== "cierre");
}
