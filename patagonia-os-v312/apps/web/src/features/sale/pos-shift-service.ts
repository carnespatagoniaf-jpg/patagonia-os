import type { ProductSalesRow } from "../shifts/sales-by-category";
import { parsePeriodResult, type PeriodResultData } from "../shifts/period-result";
import { parseActivityReport, type CashierActivity, type HourActivity } from "../shifts/sales-activity";
import { supabase } from "../../lib/supabase";
import { localDateIso } from "../shifts/format";
import { parseCountResult, type CountResult, type DeclaredPayload } from "./cash-close";

export interface PosShift {
  id: string;
  openedAt: string;
  openingCash: number;
  /** Quién atiende la caja (elegida con PIN al abrir, migración 117). */
  cashierEmployeeId?: string | null;
  cashierName?: string | null;
}

export async function getOpenPosShift(branchId: string): Promise<PosShift | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("pos_shifts")
    .select("id,opened_at,opening_cash,cashier_employee_id")
    .eq("branch_id", branchId)
    .eq("status", "open")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const cashierEmployeeId = (data as { cashier_employee_id?: string | null }).cashier_employee_id ?? null;
  let cashierName: string | null = null;
  if (cashierEmployeeId) {
    // Por RPC y no por embed: un plan sin Empleados lee la tabla vacía.
    const cashiers = await listPosCashiers(branchId).catch(() => []);
    cashierName = cashiers.find((c) => c.employeeId === cashierEmployeeId)?.fullName ?? null;
  }
  return { id: data.id, openedAt: data.opened_at, openingCash: Number(data.opening_cash ?? 0), cashierEmployeeId, cashierName };
}

export interface PosCashier {
  employeeId: string;
  fullName: string;
}

/** Empleadas con PIN de caja para esta sucursal. Lista vacía = no se pide
 * cajera al abrir (como siempre). */
export async function listPosCashiers(branchId: string | null): Promise<PosCashier[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("list_pos_cashiers", { p_branch_id: branchId });
  if (error) {
    // Base sin la migración 117: sin cajeras, como antes.
    if (error.code === "PGRST202" || error.code === "42883") return [];
    throw error;
  }
  return ((data ?? []) as { employee_id: string; full_name: string }[]).map((r) => ({ employeeId: r.employee_id, fullName: r.full_name }));
}

export async function openPosShift(
  branchId: string,
  openingCash = 0,
  cashier?: { employeeId: string; pin: string; fullName: string } | null
): Promise<PosShift> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const params: Record<string, unknown> = { p_branch_id: branchId, p_opening_cash: openingCash };
  if (cashier) {
    params.p_cashier_employee_id = cashier.employeeId;
    params.p_cashier_pin = cashier.pin;
  }
  const { data, error } = await supabase.rpc("open_pos_shift", params);
  if (error) throw error;
  return {
    id: data.id,
    openedAt: new Date().toISOString(),
    openingCash,
    cashierEmployeeId: cashier?.employeeId ?? null,
    cashierName: cashier?.fullName ?? null
  };
}

export interface SafeDepositResult {
  id: string;
  number: number;
  amount: number;
  createdAt: string;
  employeeName: string | null;
  safeAccountName: string;
  fromAccountName: string;
}

/** "Guardar en caja fuerte": traspaso Efectivo -> Caja fuerte con número
 * correlativo para el papelito que va adentro con la plata. */
export async function registerPosSafeDeposit(posShiftId: string, amount: number, fromAccountId?: string | null): Promise<SafeDepositResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("register_pos_safe_deposit", {
    p_pos_shift_id: posShiftId,
    p_amount: amount,
    p_from_account_id: fromAccountId ?? null
  });
  if (error) throw error;
  return {
    id: data.id,
    number: Number(data.number),
    amount: Number(data.amount),
    createdAt: data.created_at,
    employeeName: data.employee_name ?? null,
    safeAccountName: data.safe_account_name ?? "Caja fuerte",
    fromAccountName: data.from_account_name ?? "Efectivo"
  };
}

export async function checkPosShiftCount(
  posShiftId: string,
  declared: DeclaredPayload,
  cashier?: { employeeId: string; pin: string } | null
): Promise<CountResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("check_pos_shift_count", {
    p_pos_shift_id: posShiftId,
    p_declared: declared,
    p_employee_id: cashier?.employeeId ?? null,
    p_pin: cashier?.pin ?? null
  });
  if (error) throw error;
  return parseCountResult(data as Record<string, unknown>);
}

export async function changePosSalePaymentAccount(paymentId: string, accountId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("change_pos_sale_payment_account", { p_payment_id: paymentId, p_account_id: accountId });
  if (error) throw error;
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

/** Anula con motivo y, si la empresa tiene, PIN de autorización (149). Un PIN
 * mal puesto vuelve como { ok: false } (no como error) para que el intento
 * quede contado en la base. */
export async function voidPosSale(saleId: string, reason: string, authPin: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("void_pos_sale", { p_sale_id: saleId, p_reason: reason, p_auth_pin: authPin });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: boolean; error?: string };
  return { ok: result.ok === true, error: result.error };
}

export async function hasPosVoidPin(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("has_pos_void_pin");
  if (error) throw error;
  return data === true;
}

export async function setPosVoidPin(currentPin: string | null, newPin: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("set_pos_void_pin", { p_current_pin: currentPin, p_new_pin: newPin });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: boolean; error?: string };
  return { ok: result.ok === true, error: result.error };
}

export interface VoidedSale {
  id: string;
  soldAt: string;
  voidedAt: string;
  total: number;
  reason: string | null;
  authorized: boolean;
  voidedByName: string | null;
  cashierName: string | null;
  items: string | null;
}

export async function listPosVoidedSales(branchId: string | null, days = 14): Promise<VoidedSale[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("list_pos_voided_sales", { p_branch_id: branchId, p_days: days });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    soldAt: String(r.sold_at),
    voidedAt: String(r.voided_at),
    total: Number(r.total ?? 0),
    reason: (r.reason as string | null) ?? null,
    authorized: r.authorized === true,
    voidedByName: (r.voided_by_name as string | null) ?? null,
    cashierName: (r.cashier_name as string | null) ?? null,
    items: (r.items as string | null) ?? null
  }));
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

/** Borra un movimiento de caja (o anula un retiro a caja fuerte). Con PIN de autorización cargado lo exige (migración 153). */
export async function deletePosShiftAdjustment(movementId: string, authPin: string | null = null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("delete_pos_shift_adjustment", { p_movement_id: movementId, p_auth_pin: authPin });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: boolean; error?: string };
  if (result.ok === false) throw new Error(result.error ?? "No se pudo borrar.");
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
  id?: string;
  accountId?: string;
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
  pos_sale_payments: { id: string; account_id: string; amount: number; reference: string | null; treasury_accounts: { name: string } | null }[];
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
/** Total vendido en Mostrador entre dos fechas (sin anuladas), sumando el total de cada venta: igual que
 * close_profitability_period (sumar los pagos puede diferir por redondeos de centavos). */
export async function sumPosSalesTotalInRange(branchId: string, fromDate: string, toDate: string): Promise<number> {
  if (!supabase) return 0;
  const fromIso = new Date(`${fromDate}T00:00:00`).toISOString();
  const toIso = new Date(`${toDate}T23:59:59.999`).toISOString();
  const PAGE_SIZE = 1000;
  let total = 0;
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("pos_sales")
      .select("id,total")
      .eq("branch_id", branchId)
      .is("voided_at", null)
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("id")
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) total += Number(row.total);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return Math.round(total * 100) / 100;
}

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
        "pos_sale_payments(id,account_id,amount,reference,treasury_accounts(name))," +
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
    payments: row.pos_sale_payments.map((p) => ({ id: p.id, accountId: p.account_id, accountName: p.treasury_accounts?.name ?? "-", amount: Number(p.amount), reference: p.reference })),
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

/** Reportes → "Por categoría": lo vendido en Mostrador sumado por producto (sales_by_product, migración 114).
 * Mismos límites de día en hora local que listPosSalesInRange. */
export async function listSalesByProduct(branchId: string, fromDate: string, toDate: string): Promise<ProductSalesRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("sales_by_product", {
    p_branch_id: branchId,
    p_from: new Date(`${fromDate}T00:00:00`).toISOString(),
    p_to: new Date(`${toDate}T23:59:59.999`).toISOString()
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    productId: (r.product_id as string | null) ?? null,
    productName: String(r.product_name ?? ""),
    productCode: (r.product_code as string | null) ?? null,
    unit: (r.unit as ProductSalesRow["unit"]) ?? null,
    categoryId: (r.category_id as string | null) ?? null,
    categoryName: (r.category_name as string | null) ?? null,
    quantity: Number(r.quantity ?? 0),
    amount: Number(r.amount ?? 0),
    lines: Number(r.lines ?? 0),
    // Antes de la migración 115 la función no devolvía costo: queda en 0 (ganancia = vendido).
    cost: Number(r.cost ?? 0),
    estimatedCostLines: Number(r.estimated_cost_lines ?? 0),
    missingCostLines: Number(r.missing_cost_lines ?? 0)
  }));
}

/** Reportes → "Por cajero" y "Por día y hora" (sales_activity_report, migración 144, plan Full). */
export async function getSalesActivity(branchId: string, fromDate: string, toDate: string): Promise<{ cashiers: CashierActivity[]; hours: HourActivity[] }> {
  if (!supabase) return { cashiers: [], hours: [] };
  const { data, error } = await supabase.rpc("sales_activity_report", {
    p_branch_id: branchId,
    p_from: new Date(`${fromDate}T00:00:00`).toISOString(),
    p_to: new Date(`${toDate}T23:59:59.999`).toISOString()
  });
  if (error) throw error;
  return parseActivityReport(data);
}

/** Reportes → "Resultado del período" y "Merma" (period_result_report, migración 145, plan Full, dueño/admin). Fechas "AAAA-MM-DD" de Argentina. */
export async function getPeriodResult(branchId: string, fromDate: string, toDate: string): Promise<PeriodResultData> {
  if (!supabase) return parsePeriodResult(null);
  const { data, error } = await supabase.rpc("period_result_report", { p_branch_id: branchId, p_from: fromDate, p_to: toDate });
  if (error) throw error;
  return parsePeriodResult(data);
}
