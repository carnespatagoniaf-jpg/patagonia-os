import type { Product } from "@patagonia/domain";

export const demoProducts: Product[] = [
  {
    id: "nalga",
    code: "VAC-001",
    name: "Nalga",
    unit: "kg",
    cost: 15000,
    priceRetail: 21700,
    stock: 25,
    minStock: 10
  },
  {
    id: "vacio",
    code: "VAC-002",
    name: "Vacío",
    unit: "kg",
    cost: 16000,
    priceRetail: 22800,
    stock: 12,
    minStock: 8
  },
  {
    id: "suprema",
    code: "POL-001",
    name: "Suprema",
    unit: "kg",
    cost: 7000,
    priceRetail: 9900,
    stock: 35,
    minStock: 15
  }
];
