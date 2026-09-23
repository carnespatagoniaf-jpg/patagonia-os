import { supabase } from "../../lib/supabase";
import { localDateIso } from "../shifts/format";

export interface PosShift {
  id: string;
  openedAt: string;
  openingCash: number;
}

export async function getOpenPosShift(branchId: string): Promise<PosShift | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("pos_shifts")
    .select("id,opened_at,opening_cash")
    .eq("branch_id", branchId)
    .eq("status", "open")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { id: data.id, openedAt: data.opened_at, openingCash: Number(data.opening_cash ?? 0) };
}

export async function openPosShift(branchId: string, openingCash = 0): Promise<PosShift> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("open_pos_shift", { p_branch_id: branchId, p_opening_cash: openingCash });
  if (error) throw error;
  return { id: data.id, openedAt: new Date().toISOString(), openingCash };
}

export interface CloseShiftAccountSummary {
  accountId: string;
  amount: number;
  salesCount: number;
}

export interface CloseShiftResult {
  total: number;
  byAccount: CloseShiftAccountSummary[];
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  /** Desglose del efectivo esperado -- null si el servidor todavía no
   * devuelve estos campos (versión anterior de close_pos_shift). */
  breakdown: {
    openingCash: number;
    cashSales: number;
    cashOutflows: number;
    cashInflows: number;
    cashVales: number;
    cashSupplierPayments: number;
    /** Salidas del turno (vales, pagos, egresos) cargadas contra cuentas
     * que NO son efectivo -- no se restan del efectivo esperado. */
    noncashOutflows: number;
  } | null;
}

export async function closePosShift(shiftId: string, closingCountedCash?: number): Promise<CloseShiftResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("close_pos_shift", {
    p_pos_shift_id: shiftId,
    p_closing_counted_cash: closingCountedCash ?? null
  });
  if (error) throw error;
  return {
    total: Number(data.total),
    byAccount: (data.by_account ?? []).map((row: { account_id: string; amount: number; sales_count: number }) => ({
      accountId: row.account_id,
      amount: Number(row.amount),
      salesCount: Number(row.sales_count)
    })),
    expectedCash: Number(data.expected_cash ?? 0),
    countedCash: data.counted_cash !== null && data.counted_cash !== undefined ? Number(data.counted_cash) : null,
    difference: data.difference !== null && data.difference !== undefined ? Number(data.difference) : null,
    breakdown:
      data.cash_outflows !== undefined && data.cash_outflows !== null
        ? {
            openingCash: Number(data.opening_cash ?? 0),
            cashSales: Number(data.cash_sales ?? 0),
            cashOutflows: Number(data.cash_outflows ?? 0),
            cashInflows: Number(data.cash_inflows ?? 0),
            cashVales: Number(data.cash_vales ?? 0),
            cashSupplierPayments: Number(data.cash_supplier_payments ?? 0),
            noncashOutflows: Number(data.noncash_outflows ?? 0)
          }
        : null
  };
}

export async function voidPosSale(saleId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("void_pos_sale", { p_sale_id: saleId });
  if (error) throw error;
}

export interface PosShiftAdjustment {
  id: string;
  direction: "in" | "out";
  amount: number;
  movementType: string;
  accountName: string;
  notes: string | null;
  createdAt: string;
}

interface PosShiftAdjustmentRow {
  id: string;
  direction: "in" | "out";
  amount: number;
  movement_type: string;
  notes: string | null;
  created_at: string;
  treasury_accounts: { name: string } | null;
}

/** "Movimiento de caja" (Ingreso/Egreso) y traspasos hechos desde Mostrador
 * -- para poder listarlos y borrar uno mal cargado mientras el turno sigue
 * abierto. No incluye pagos a proveedor (esos se editan desde Compras). */
export async function listPosShiftAdjustments(posShiftId: string): Promise<PosShiftAdjustment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("treasury_movements")
    .select("id,direction,amount,movement_type,notes,created_at,treasury_accounts(name)")
    .or(`and(reference_type.eq.pos_shift,reference_id.eq.${posShiftId}),pos_shift_id.eq.${posShiftId}`)
    .in("movement_type", ["ajuste", "transferencia"])
    .order("created_at");

  if (error) throw error;
  return ((data ?? []) as unknown as PosShiftAdjustmentRow[]).map((row) => ({
    id: row.id,
    direction: row.direction,
    amount: Number(row.amount),
    movementType: row.movement_type,
    accountName: row.treasury_accounts?.name ?? "-",
    notes: row.notes,
    createdAt: row.created_at
  }));
}

export interface PosShiftSupplierPayment {
  id: string;
  supplierName: string;
  accountName: string;
  amount: number;
  notes: string | null;
  createdAt: string;
}

/** Pagos a proveedores hechos desde Mostrador durante un turno ("+ Pago a
 * proveedor", 065) -- para el detalle y el ticket del cierre. */
export async function listPosShiftSupplierPayments(posShiftId: string): Promise<PosShiftSupplierPayment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("treasury_movements")
    .select("id,reference_id,amount,notes,created_at,treasury_accounts(name)")
    .eq("pos_shift_id", posShiftId)
    .eq("movement_type", "pago_proveedor")
    .order("created_at");
  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    id: string;
    reference_id: string | null;
    amount: number;
    notes: string | null;
    created_at: string;
    treasury_accounts: { name: string } | null;
  }[];
  if (rows.length === 0) return [];

  const paymentIds = rows.map((r) => r.reference_id).filter((id): id is string => !!id);
  const supplierByPayment = new Map<string, string>();
  if (paymentIds.length > 0) {
    const { data: payments, error: paymentsError } = await supabase
      .from("supplier_payments")
      .select("id,suppliers(name)")
      .in("id", paymentIds);
    if (paymentsError) throw paymentsError;
    for (const p of (payments ?? []) as unknown as { id: string; suppliers: { name: string } | null }[]) {
      if (p.suppliers?.name) supplierByPayment.set(p.id, p.suppliers.name);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    supplierName: (r.reference_id && supplierByPayment.get(r.reference_id)) || "Proveedor",
    accountName: r.treasury_accounts?.name ?? "-",
    amount: Number(r.amount),
    notes: r.notes,
    createdAt: r.created_at
  }));
}

export async function deletePosShiftAdjustment(movementId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_pos_shift_adjustment", { p_movement_id: movementId });
  if (error) throw error;
}

export interface RegisterPosShiftTransferInput {
  posShiftId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  reason?: string;
}

/** Traspaso de una cuenta a otra (ej. Efectivo -> Caja fuerte) que sí
 * descuenta del arqueo de este turno, a diferencia de la transferencia
 * genérica de Tesorería. */
export async function registerPosShiftTransfer(input: RegisterPosShiftTransferInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("register_pos_shift_transfer", {
    p_pos_shift_id: input.posShiftId,
    p_from_account_id: input.fromAccountId,
    p_to_account_id: input.toAccountId,
    p_amount: input.amount,
    p_reason: input.reason ?? null
  });

  if (error) throw error;
}

export interface PosShiftSaleItem {
  productName: string;
  quantity: number;
  unit: "kg" | "unit" | "box";
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface PosShiftSalePayment {
  accountName: string;
  amount: number;
  reference: string | null;
}

export interface PosShiftSale {
  id: string;
  createdAt: string;
  payments: PosShiftSalePayment[];
  discountAmount: number;
  surchargeAmount: number;
  total: number;
  voidedAt: string | null;
  items: PosShiftSaleItem[];
}

interface PosShiftSaleRow {
  id: string;
  created_at: string;
  discount_amount: number;
  surcharge_amount: number;
  total: number;
  voided_at: string | null;
  pos_sale_payments: { amount: number; reference: string | null; treasury_accounts: { name: string } | null }[];
  pos_sale_items: {
    quantity: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    description: string | null;
    product_id: string | null;
  }[];
}

export interface MostradorSaleEntry {
  date: string;
  accountId: string;
  amount: number;
}

interface PosSaleRangeRow {
  id: string;
  amount: number;
  account_id: string;
  pos_sales: { created_at: string; voided_at: string | null; branch_id: string };
}

/** Ventas de Mostrador (no Turnos) para reportes/dashboard, en la misma
 * forma (fecha, cuenta, monto) que las ventas de Turnos, para poder
 * sumarlas juntas -- ver 049 y la discusión de "Ventas hoy" incompleto
 * porque solo miraba Turnos. */
export async function listPosSalesInRange(branchId: string, fromDate: string, toDate: string): Promise<MostradorSaleEntry[]> {
  if (!supabase) return [];

  // Los límites son el día completo en hora LOCAL (no UTC): en Argentina una
  // venta de las 22:00 ya es "mañana" en UTC y caía en el día equivocado. Además
  // se pagina de a 1000 filas: PostgREST corta en 1000 sin avisar, y un rango
  // con muchas ventas devolvía un total incompleto.
  const fromIso = new Date(`${fromDate}T00:00:00`).toISOString();
  const toIso = new Date(`${toDate}T23:59:59.999`).toISOString();
  const PAGE_SIZE = 1000;
  const rows: PosSaleRangeRow[] = [];

  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("pos_sale_payments")
      .select("id,amount,account_id,pos_sales!inner(created_at,voided_at,branch_id)")
      .eq("pos_sales.branch_id", branchId)
      .is("pos_sales.voided_at", null)
      .gte("pos_sales.created_at", fromIso)
      .lte("pos_sales.created_at", toIso)
      .order("id")
      .range(start, start + PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as unknown as PosSaleRangeRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return rows.map((row) => ({
    date: localDateIso(new Date(row.pos_sales.created_at)),
    accountId: row.account_id,
    amount: Number(row.amount)
  }));
}

export async function listPosShiftSales(shiftId: string): Promise<PosShiftSale[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("pos_sales")
    .select(
      "id,created_at,discount_amount,surcharge_amount,total,voided_at," +
        "pos_sale_payments(amount,reference,treasury_accounts(name))," +
        "pos_sale_items(quantity,unit_price,discount_amount,line_total,description,product_id)"
    )
    .eq("pos_shift_id", shiftId)
    .order("created_at");

  if (error) throw error;
  const rows = (data ?? []) as unknown as PosShiftSaleRow[];

  // El nombre/unidad del producto NO se embebe (products(name,unit)): desde
  // 051_hide_cost_from_cashiers.sql el rol authenticated no tiene SELECT
  // sobre products, y ese embed hacía fallar TODA esta consulta con 403 --
  // el turno no cargaba ventas, ni vales, ni movimientos de caja. Se lee de
  // la vista products_price_list, que sí está habilitada y no trae costo.
  const productIds = [...new Set(rows.flatMap((r) => r.pos_sale_items.map((i) => i.product_id)).filter((id): id is string => !!id))];
  const productById = new Map<string, { name: string; unit: "kg" | "unit" | "box" }>();
  for (let i = 0; i < productIds.length; i += 80) {
    const { data: products, error: productsError } = await supabase
      .from("products_price_list")
      .select("id,name,unit")
      .in("id", productIds.slice(i, i + 80));
    if (productsError) throw productsError;
    for (const p of (products ?? []) as { id: string; name: string; unit: "kg" | "unit" | "box" }[]) {
      productById.set(p.id, { name: p.name, unit: p.unit });
    }
  }

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    payments: row.pos_sale_payments.map((p) => ({ accountName: p.treasury_accounts?.name ?? "-", amount: Number(p.amount), reference: p.reference })),
    discountAmount: Number(row.discount_amount),
    surchargeAmount: Number(row.surcharge_amount ?? 0),
    total: Number(row.total),
    voidedAt: row.voided_at,
    items: row.pos_sale_items.map((item) => ({
      productName: (item.product_id && productById.get(item.product_id)?.name) || item.description || "-",
      quantity: Number(item.quantity),
      unit: (item.product_id && productById.get(item.product_id)?.unit) || "unit",
      unitPrice: Number(item.unit_price),
      discountAmount: Number(item.discount_amount),
      lineTotal: Number(item.line_total)
    }))
  }));
}
