import { addDaysIso, localDateIso } from "../shifts/format";
import type { CustomerOrder, OrderItem } from "./orders-logic";

/** Modo demostración (sin base): pedidos de ejemplo con fechas y horas relativas a ahora, para ver la pantalla andando. */
export function demoSeedOrders(now: Date = new Date()): CustomerOrder[] {
  const P: Record<string, [string, OrderItem["unit"]]> = {
    asado: ["Asado", "kg"], vacio: ["Vacío", "kg"], matambre: ["Matambre", "kg"], chorizo: ["Chorizo", "unit"],
    morcilla: ["Morcilla", "unit"], provoleta: ["Provoleta", "unit"], carbon: ["Carbón bolsa 4 kg", "unit"],
    entrana: ["Entraña", "kg"], pechito: ["Pechito de cerdo", "kg"]
  };
  const it = (id: string, quantity: number, notes: string | null = null): OrderItem => ({ productId: id, productName: P[id][0], unit: P[id][1], quantity, notes });
  const today = localDateIso(now);
  const at = (hours: number, minutes: string) => `${String(Math.min(23, Math.max(0, now.getHours() + hours))).padStart(2, "0")}:${minutes}`;
  let n = 0;
  const order = (offset: number, time: string | null, name: string, phone: string | null, items: OrderItem[], extra: Partial<CustomerOrder> = {}): CustomerOrder => ({
    id: `demo-${++n}`, branchId: "demo-branch", customerId: null, customerName: name, customerPhone: phone,
    pickupDate: addDaysIso(today, offset), pickupTime: time, notes: null, total: null, deposit: 0, status: "pendiente",
    createdAt: new Date(now.getTime() - n * 3_600_000).toISOString(), items, ...extra
  });
  return [
    order(0, at(-2, "00"), "Roberto Díaz", "2944 551 203", [it("vacio", 2)], { status: "entregado", total: 32000 }),
    order(0, at(-1, "00"), "Marta Gómez", "2944 418 776", [it("matambre", 1.5), it("morcilla", 2)], { total: 27800, deposit: 5000 }),
    order(0, at(0, "50"), "Juan Pérez", "2944 123 456", [it("asado", 2.5, "en tiras"), it("chorizo", 6), it("morcilla", 3), it("carbon", 1)], { notes: "Lo pasa a buscar el hijo", total: 64500, deposit: 10000 }),
    order(0, at(2, "30"), "Laura Fernández", "2944 302 118", [it("vacio", 1.5), it("provoleta", 1)], { status: "listo", total: 28200, deposit: 28200 }),
    order(0, at(5, "00"), "Carlos Ruiz", null, [it("entrana", 1), it("chorizo", 4)]),
    order(1, "10:30", "Sofía Álvarez", "2944 660 019", [it("pechito", 3)], { total: 29400, deposit: 10000 }),
    order(1, null, "Club Atlético Sur", "2944 700 300", [it("asado", 12), it("chorizo", 30), it("morcilla", 15), it("carbon", 4)], { total: 280000, deposit: 100000 }),
    order(3, "11:00", "Familia Rossi", null, [it("asado", 4), it("chorizo", 8), it("carbon", 2)]),
    order(3, "12:30", "Ana Torres", null, [it("vacio", 3), it("provoleta", 2)]),
    order(4, "10:00", "Pablo Medina", null, [it("asado", 6), it("matambre", 2), it("chorizo", 12)])
  ];
}
