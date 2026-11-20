/**
 * Base de EJEMPLO para ver el panel de plataforma sin entrar con la cuenta real ni tocar staging/producción.
 * Solo la usa la vista de prueba (`panel-preview.html` + `vite.panel-preview.config.ts`), que reemplaza
 * `lib/supabase` por este archivo. No entra en la web publicada.
 */

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const date = (offsetDays: number) => iso(offsetDays).slice(0, 10);

type Demo = {
  name: string; owner: string; email: string; phone: string; province: string; city: string; plan: string;
  /** Días hasta el vencimiento (negativo = vencido). null = nunca pagó. */
  paid: number | null; trial: number | null; lastPay: number | null; sales7d: number; lastSale: number | null; signIn: number | null; products: number;
  /** Ventas por semana de antes (para mostrar a quién se le cayeron las ventas). Sin dato = igual que esta semana. */
  usual?: number;
  active?: boolean; branches?: number; users?: number;
};

const DEMO: Demo[] = [
  { name: "Carnicería El Novillo", owner: "Ana Pérez", email: "ana@ejemplo.com", phone: "2804 555-101", province: "Chubut", city: "Trelew", plan: "full", paid: 23, trial: null, lastPay: -7, sales7d: 412, lastSale: 0, signIn: 0, products: 184, branches: 2, users: 5 },
  { name: "Granja La Esquina", owner: "Marcos Díaz", email: "marcos@ejemplo.com", phone: "299 555-202", province: "Neuquén", city: "Neuquén", plan: "estandar", paid: -9, trial: null, lastPay: -40, sales7d: 230, lastSale: -1, signIn: -1, products: 96 },
  { name: "Fiambrería Don Tito", owner: "Rubén Sosa", email: "ruben@ejemplo.com", phone: "2966 555-303", province: "Santa Cruz", city: "Río Gallegos", plan: "estandar", paid: 9, trial: null, lastPay: -21, sales7d: 41, lastSale: -1, signIn: -6, products: 140, usual: 300 },
  { name: "Súper Los Andes", owner: "Lucía Gómez", email: "lucia@ejemplo.com", phone: "260 555-404", province: "Mendoza", city: "San Rafael", plan: "full", paid: null, trial: 4, lastPay: null, sales7d: 0, lastSale: null, signIn: -2, products: 12 },
  { name: "Pollería Doña Rosa", owner: "Rosa Medina", email: "rosa@ejemplo.com", phone: "2920 555-505", province: "Río Negro", city: "Viedma", plan: "basico", paid: 47, trial: null, lastPay: -13, sales7d: 288, lastSale: -2, signIn: -2, products: 58 },
  { name: "Carnes del Sur", owner: "Javier Ruiz", email: "javier@ejemplo.com", phone: "2901 555-606", province: "Tierra del Fuego", city: "Ushuaia", plan: "estandar", paid: 3, trial: null, lastPay: -27, sales7d: 356, lastSale: 0, signIn: 0, products: 210 },
  { name: "La Vaquita", owner: "Sofía Herrera", email: "sofia@ejemplo.com", phone: "2954 555-707", province: "La Pampa", city: "Santa Rosa", plan: "full", paid: 15, trial: null, lastPay: -15, sales7d: 501, lastSale: 0, signIn: 0, products: 230, branches: 3, users: 8 },
  { name: "Frigorífico Patagones", owner: "Pedro Acosta", email: "pedro@ejemplo.com", phone: "2920 555-808", province: "Buenos Aires", city: "Carmen de Patagones", plan: "full", paid: 28, trial: null, lastPay: -2, sales7d: 97, lastSale: -1, signIn: -1, products: 75 },
  { name: "Almacén Lo de Menon", owner: "Carla Benítez", email: "carla@ejemplo.com", phone: "387 555-909", province: "Salta", city: "Salta", plan: "estandar", paid: null, trial: -3, lastPay: null, sales7d: 0, lastSale: null, signIn: -5, products: 0 },
  { name: "Carnicería San Cayetano", owner: "Hugo Castro", email: "hugo@ejemplo.com", phone: "351 555-010", province: "Córdoba", city: "Villa María", plan: "estandar", paid: -2, trial: null, lastPay: -32, sales7d: 12, lastSale: -5, signIn: -4, products: 120, usual: 150 },
  { name: "El Buen Corte", owner: "Laura Ríos", email: "laura@ejemplo.com", phone: "", province: "Santa Fe", city: "Rafaela", plan: "basico", paid: null, trial: null, lastPay: null, sales7d: 0, lastSale: -60, signIn: -58, products: 44, active: false }
];

const companies = DEMO.map((d, i) => ({
  id: `c${i + 1}`,
  name: d.name,
  active: d.active ?? true,
  created_at: iso(-200 + i * 14),
  branch_count: d.branches ?? 1,
  user_count: d.users ?? 2,
  owner_id: `u${i + 1}`,
  owner_full_name: d.owner,
  owner_email: d.email,
  contact_phone: d.phone || null,
  province: d.province,
  city: d.city,
  trial_ends_at: d.trial === null ? null : iso(d.trial),
  client_number: i + 1,
  paid_until: d.paid === null ? null : date(d.paid),
  last_payment_date: d.lastPay === null ? null : date(d.lastPay),
  last_payment_amount: d.lastPay === null ? null : 39000
}));

const payments: Record<string, Array<{ id: string; payment_date: string; amount: number | null; months: number; paid_until: string; note: string | null }>> = {};
DEMO.forEach((d, i) => {
  if (d.lastPay === null || d.paid === null) return;
  payments[`c${i + 1}`] = [
    { id: `p${i}a`, payment_date: date(d.lastPay), amount: 39000, months: 1, paid_until: date(d.paid), note: "Transferencia" },
    { id: `p${i}b`, payment_date: date(d.lastPay - 30), amount: 39000, months: 1, paid_until: date(d.paid - 30), note: null }
  ];
});

const features: Record<string, string[]> = { c1: ["cuentas", "gastos"], c4: ["sin_carniceria"], c8: ["frigorifico"] };

function monthly() {
  const out: Array<{ month: string; amount: number; count: number }> = [];
  const now = new Date();
  for (let k = 11; k >= 0; k--) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const count = Math.max(0, 12 - k + (k < 3 ? 3 : 0));
    out.push({ month, amount: count * 39000, count });
  }
  return out;
}

function rpc(name: string, args: Record<string, unknown> = {}): unknown {
  switch (name) {
    case "list_companies_for_admin": return companies;
    case "list_company_plans": return DEMO.map((d, i) => ({ company_id: `c${i + 1}`, plan: d.plan, active_branches: d.branches ?? 1, active_users: d.users ?? 2 }));
    case "list_company_features": return companies.map((c) => ({ company_id: c.id, features: features[c.id] ?? [] }));
    case "set_company_feature": {
      const id = String(args.p_company_id);
      const set = new Set(features[id] ?? []);
      if (args.p_enabled) set.add(String(args.p_feature)); else set.delete(String(args.p_feature));
      features[id] = [...set];
      return features[id];
    }
    case "list_company_payments": return payments[String(args.p_company_id)] ?? [];
    case "register_company_payment": return date(30 * Number(args.p_months ?? 1));
    case "list_sales_pipeline_for_admin":
      return DEMO.map((d, i) => ({
        company_id: `c${i + 1}`, product_count: d.products, sale_count: (d.usual ?? d.sales7d) * 20 + d.sales7d, sales_last_7d: d.sales7d,
        first_sale_at: d.lastSale === null ? null : iso(-147), last_sale_at: d.lastSale === null ? null : iso(d.lastSale),
        closed_shift_count: 40, purchase_count: 12, last_sign_in_at: d.signIn === null ? null : iso(d.signIn),
        sales_note: null, sales_contacted_at: null, sales_lost_reason: null
      }));
    case "list_mp_subscriptions_for_admin":
      return [
        { id: "mp1", company_id: "c7", company_name: "La Vaquita", status: "authorized", reason: "Abono", payer_name: "Sofía Herrera", payer_email: "sofia@ejemplo.com", amount: 39000, date_created: iso(-120), next_payment_date: iso(15), last_charge_date: iso(-15), last_charge_status: "approved", last_payment_status: "approved", last_payment_status_detail: null, last_retry_attempt: null, approved_count: 4, synced_at: iso(0) }
      ];
    case "mp_sync_status": return { scheduled: true, last_run_at: iso(-0.02), last_result: null };
    case "list_scale_support_access": return [];
    case "scale_support_tools_enabled": return false;
    case "list_scale_support_reports": return [];
    case "platform_daily_checks":
      return companies.filter((c) => c.active).map((c, i) => ({
        id: c.id, name: c.name, plan: DEMO[i].plan, in_trial: DEMO[i].trial !== null, products: DEMO[i].products,
        last_sale_at: DEMO[i].lastSale === null ? null : iso(DEMO[i].lastSale!), open_shifts_old: c.id === "c2" ? 1 : 0, oldest_open_shift: c.id === "c2" ? iso(-3) : null,
        negative_stock: c.id === "c3" ? 4 : 0, below_cost: c.id === "c6" ? 2 : 0, stuck_invoices: 0, problems: 0
      }));
    case "get_platform_summary":
      return {
        monthly: monthly(), new_this_month: 2, lost_this_month: ["El Buen Corte"], trials_60d: 5, trials_60d_paid: 3, usage_since: date(-60),
        usage_30d: [{ page: "sale", companies: 9 }, { page: "inventory", companies: 8 }, { page: "customers", companies: 7 }, { page: "purchases", companies: 5 }, { page: "invoicing", companies: 3 }],
        unanswered_7d: [{ question: "¿Cómo cargo una oferta 2x1?", count: 3, companies: ["Súper Los Andes"] }]
      };
    case "list_platform_leads":
      return [
        { id: "l1", business_name: "Carnicería Los Hermanos", contact_name: "Diego", phone: "2974 555-111", province: "Chubut", city: "Comodoro Rivadavia", stage: "contacto", source: "Kommo", note: "Preguntó si anda con balanza Systel", next_contact_on: date(0), lost_reason: null, company_id: null, created_at: iso(-2), attempts: 1, last_contacted_at: iso(-2), replied_at: null, kommo_contact_id: 1001 },
        { id: "l2", business_name: "Fiambrería La Nona", contact_name: "Marta", phone: "343 555-222", province: "Entre Ríos", city: "Paraná", stage: "demo", source: "Instagram", note: null, next_contact_on: date(1), lost_reason: null, company_id: null, created_at: iso(-6), attempts: 2, last_contacted_at: iso(-1), replied_at: iso(-1), kommo_contact_id: 1002 },
        { id: "l3", business_name: "Granja El Ceibo", contact_name: "Raúl", phone: "3456 555-333", province: "Entre Ríos", city: "Concordia", stage: "contacto", source: "Kommo", note: null, next_contact_on: date(0), lost_reason: null, company_id: null, created_at: iso(-1), attempts: 0, last_contacted_at: null, replied_at: null, kommo_contact_id: 1003 },
        { id: "l4", business_name: "Supermercado Don Pepe", contact_name: null, phone: "381 555-444", province: "Tucumán", city: "Tucumán", stage: "perdido", source: "Facebook", note: null, next_contact_on: null, lost_reason: "Le pareció caro", company_id: null, created_at: iso(-30), attempts: 3, last_contacted_at: iso(-20), replied_at: null, kommo_contact_id: null }
      ];
    case "fin_overview":
      return {
        accounts: [
          { id: "a1", name: "Mercado Pago", currency: "ARS", openingBalance: 0, receivesPayments: true, active: true, balance: 842000 },
          { id: "a2", name: "Banco", currency: "ARS", openingBalance: 150000, receivesPayments: false, active: true, balance: 310500 },
          { id: "a3", name: "Dólares", currency: "USD", openingBalance: 500, receivesPayments: false, active: true, balance: 380 }
        ],
        partners: [{ id: "s1", name: "Socio 1", sharePct: 50 }, { id: "s2", name: "Socio 2", sharePct: 50 }],
        recurring: [
          { id: "r1", name: "Supabase", category: "Servidores", amount: 25, accountId: "a3", dayOfMonth: 5, fromInvestment: false, active: true },
          { id: "r2", name: "Netlify", category: "Servidores", amount: 19, accountId: "a3", dayOfMonth: 10, fromInvestment: false, active: true }
        ],
        movements: [
          { id: "m1", date: date(-2), accountId: "a1", kind: "ingreso", direction: "in", amount: 39000, category: "Abonos", description: "Abono La Vaquita", partnerId: null, fromInvestment: false, fromPayment: true, transferId: null },
          { id: "m2", date: date(-4), accountId: "a2", kind: "gasto", direction: "out", amount: 120000, category: "Publicidad", description: "Meta Ads", partnerId: null, fromInvestment: false, fromPayment: false, transferId: null },
          { id: "m3", date: date(-6), accountId: "a3", kind: "gasto", direction: "out", amount: 25, category: "Servidores", description: "Supabase", partnerId: null, fromInvestment: false, fromPayment: false, transferId: null }
        ],
        investment: [],
        investmentSpent: [],
        monthly: [{ month: date(0).slice(0, 7) + "-01", currency: "ARS", income: 585000, expenses: 160000 }]
      };
    case "fin_meta_status": return { connected: false };
    case "get_daily_summary_settings":
      return { enabled: false, recipients: [], send_hour: 8, url_set: true, last_sent_on: null, last_run_at: null, last_result: null };
    case "kommo_sync_status": return null;
    case "list_payments_for_admin": return [];
    default:
      // Escrituras (set_company_plan, set_company_trial, …): en la vista de prueba no guardan nada.
      return null;
  }
}

function query() {
  const result = { data: [], error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "order", "limit", "gte", "lte", "is", "match", "single", "maybeSingle"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

export const isSupabaseConfigured = true;

export const supabase = {
  rpc: async (name: string, args?: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r, 250));
    return { data: rpc(name, args), error: null };
  },
  from: () => query(),
  functions: {
    invoke: async (name: string) => {
      await new Promise((r) => setTimeout(r, 400));
      if (name === "admin-reset-password") return { data: { password: "Ejemplo-4821" }, error: null };
      if (name === "mp-sync") return { data: { connected: true, subscriptions: 1, charges: 4, applied: 0 }, error: null };
      return { data: { ok: true }, error: null };
    }
  },
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } })
  }
};
