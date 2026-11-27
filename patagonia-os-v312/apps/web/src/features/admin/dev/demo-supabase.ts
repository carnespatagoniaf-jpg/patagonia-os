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

// Centro de diagnóstico de balanzas (migración 230), con mensajes reales de producción.
const scaleReports = [
  { id: "sr1", company_id: "c1", company_name: "Carnicería El Novillo", branch_name: "Centro", created_at: iso(-0.1), resolved_at: null as string | null,
    note: "Mis balanzas (Systel) · sincronizar (frenado): 4 productos no quedaron bien",
    log_text: JSON.stringify({ cuando: iso(-0.1), etapa: "sincronizar (frenado)", mensaje: "Frenamos para cuidar tus productos: no se cambió nada más en la balanza. 4 productos no quedaron bien en la balanza (respuesta 21)", tecnico: "envio: stoppedAt PLU 12, respuesta 21", cable: { usb: "FTDI 0403:6001", com: "COM3" }, version: "2026-11-27", pasos: [{ label: "Abrir puerto", ok: true, detail: "115200" }, { label: "Escribir PLU 12", ok: false, detail: "respuesta 21" }], password: "Secreta123" }) },
  { id: "sr2", company_id: "c6", company_name: "Carnes del Sur", branch_name: "Ushuaia", created_at: iso(-1), resolved_at: null as string | null,
    note: "Mis balanzas (Report) · conectar: No elegiste la balanza en la lista",
    log_text: JSON.stringify({ etapa: "conectar", mensaje: 'No elegiste la balanza en la lista. Tocá "Conectar balanza" de nuevo y elegí la que dice USB.', tecnico: "NotFoundError: No port selected by the user.", cable: null, pasos: [] }) },
  { id: "sr3", company_id: "c1", company_name: "Carnicería El Novillo", branch_name: "Centro", created_at: iso(-4), resolved_at: iso(-3) as string | null,
    note: "Mis balanzas (Report) · conectar: Otro programa tiene tomada la balanza",
    log_text: JSON.stringify({ etapa: "conectar", mensaje: "Otro programa tiene tomada la balanza (por ejemplo Qendra, el programa de la balanza, u otra ventana de Chrome o Edge). Cerralo y probá de nuevo.", tecnico: "NetworkError: Failed to open serial port." }) }
];

function scaleOverview() {
  const open = (c: string) => scaleReports.filter((r) => r.company_id === c && !r.resolved_at).length;
  const lastOpen = (c: string) => scaleReports.find((r) => r.company_id === c && !r.resolved_at);
  const row = (c: string, name: string, plan: string, branch: string, o: Record<string, unknown>) => ({
    company_id: c, company_name: name, company_active: true, plan, balanzas_v2: c === "c1", branch_id: `${c}b`, branch_name: branch,
    scales_active: 1, scales_by_brand: { kretz: 1 }, duplicate_groups: 0, connectors_active: 0, connectors_online: 0, connectors_stale: 0,
    connector_version_min: null, connector_version_max: null, connector_last_seen: null, last_job_at: iso(-1), last_job_status: "done",
    last_job_confirmed: 40, last_job_requested: 40, jobs_failed_7d: 0, jobs_stuck: 0, reports_open: open(c), last_report_at: lastOpen(c)?.created_at ?? null,
    last_open_report_stage: lastOpen(c) ? JSON.parse(lastOpen(c)!.log_text).etapa : null, last_open_report_message: lastOpen(c) ? JSON.parse(lastOpen(c)!.log_text).mensaje : null,
    light: "verde", light_reason: "Sin problemas", ...o
  });
  return [
    row("c1", "Carnicería El Novillo", "full", "Centro", { scales_active: 3, scales_by_brand: { kretz: 2, systel: 1 }, duplicate_groups: 1, connectors_active: 1, connectors_online: 1, connector_version_min: "0.2.0", connector_version_max: "0.2.0", connector_last_seen: iso(-0.0005), last_job_status: "failed", last_job_confirmed: 0, last_job_requested: 10, jobs_failed_7d: 2 }),
    row("c6", "Carnes del Sur", "estandar", "Ushuaia", {}),
    row("c5", "Pollería Doña Rosa", "basico", "Viedma", { last_job_status: "partial", last_job_confirmed: 18, last_job_requested: 20 }),
    row("c7", "La Vaquita", "full", "Santa Rosa", { scales_active: 2, connectors_active: 2, connectors_online: 2, connector_version_min: "0.2.0", connector_version_max: "0.2.0", connector_last_seen: iso(-0.0003) }),
    row("c7", "La Vaquita", "full", "General Pico", { branch_id: "c7b2", connectors_active: 1, connectors_stale: 1, connector_version_min: "0.1.9", connector_version_max: "0.1.9", connector_last_seen: iso(-3), last_job_at: iso(-3) })
  ];
}

function scaleDetail(companyId: string) {
  const c = companies.find((x) => x.id === companyId)!;
  const failing = companyId === "c1";
  return {
    company: { id: c.id, name: c.name, active: true, plan: DEMO[Number(c.id.slice(1)) - 1].plan, balanzas_v2: companyId === "c1" },
    scales: [
      { branch_name: "Centro", scale_key: "kretz-1", name: "Report de la Caja 1", brand: "kretz", model: "Report LT", family: "kretz", identity: { serie: "A10KX3" }, label_spec: { prefixes: { weighed: "21", unit: "20", total: null }, writer: { kind: "kretz1070", code: "2112005" } }, status: "active", active: true, install: { model: "Report LT", detectedAt: iso(-20), communicationAt: iso(-20), sentAt: iso(-1), sentCount: 40, verifiedAt: iso(-1), verifiedCount: 40, failedCount: 0 }, connector_name: "Caja 1", connector_device: { com: "COM3", usb: "FTDI A10KX3" }, last_used_at: iso(-1) },
      ...(failing ? [
        { branch_name: "Centro", scale_key: "kretz-2", name: "Report (repetida)", brand: "kretz", model: "Report LT", family: "kretz", identity: { serie: "A10KX3" }, label_spec: null, status: "active", active: true, install: {}, connector_name: null, connector_device: null, last_used_at: iso(-30) },
        { branch_name: "Centro", scale_key: "systel-1", name: "Cuora Max", brand: "systel", model: "Cuora Max", family: "systel", identity: { serie: "S9" }, label_spec: { prefixes: { weighed: "23", unit: "24", total: null }, writer: { kind: "systel", weighed: "23PPPPCCCCCC", unit: "24PPPPCCCCCC" } }, status: "active", active: true, install: { lastError: "4 productos no quedaron bien", lastErrorAt: iso(-0.1) }, connector_name: "Caja 1", connector_device: { ip: "192.168.0.50", port: 3001 }, last_used_at: iso(-0.1) }
      ] : [])
    ],
    connectors: [{ id: "k1", name: "Caja 1", branch_name: "Centro", version: "0.2.0", status: "active", last_seen_at: iso(-0.0005), online: true, seen_scales: 2, paired_at: iso(-10), revoked_at: null }],
    jobs: [
      ...(failing ? [{ id: "j1", branch_name: "Centro", scale_key: "systel-1", scale_name: "Cuora Max", kind: "send", source: "connector", status: "failed", requested_count: 10, confirmed_count: 0, failed_count: 10, skipped_count: 0, started_at: iso(-0.1), finished_at: iso(-0.1), error_code: "envio", app_version: "0.2.0", connector_name: "Caja 1" }] : []),
      { id: "j2", branch_name: "Centro", scale_key: "kretz-1", scale_name: "Report de la Caja 1", kind: "send", source: "web", status: "done", requested_count: 40, confirmed_count: 40, failed_count: 0, skipped_count: 0, started_at: iso(-1), finished_at: iso(-1), error_code: null, app_version: "2026-11-26", connector_name: null }
    ],
    failed_products: failing ? [
      { product: "Asado de tira", plu: "12", reason: "la balanza rechazó el alta (respuesta 21)", times: 3, last_at: iso(-0.1) },
      { product: "Vacío", plu: "40", reason: "E5", times: 1, last_at: iso(-0.1) }
    ] : [],
    reports: scaleReports.filter((r) => r.company_id === companyId).map((r) => {
      const j = JSON.parse(r.log_text);
      return { id: r.id, branch_name: r.branch_name, user_name: "Cajero", created_at: r.created_at, resolved_at: r.resolved_at, note: r.note, etapa: j.etapa, mensaje: j.mensaje, tecnico: j.tecnico, app_version: j.version ?? null, log_length: r.log_text.length };
    }),
    ambiguities_supported: false,
    ambiguities: []
  };
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
        { id: "mp1", company_id: "c7", company_name: "La Vaquita", status: "authorized", reason: "Abono", payer_name: "Sofía Herrera", payer_email: "sofia@ejemplo.com", amount: 39000, date_created: iso(-120), next_payment_date: iso(15), last_charge_date: iso(-15), last_charge_status: "approved", last_payment_status: "approved", last_payment_status_detail: null, last_retry_attempt: null, approved_count: 4, synced_at: iso(0) },
        { id: "mp2", company_id: null, company_name: null, status: "authorized", reason: "Abono", payer_name: "Granja La Esquina SRL", payer_email: null, amount: 39000, date_created: iso(-60), next_payment_date: iso(10), last_charge_date: iso(-20), last_charge_status: "processed", last_payment_status: "approved", last_payment_status_detail: null, last_retry_attempt: null, approved_count: 2, synced_at: iso(0) },
        { id: "mp3", company_id: null, company_name: null, status: "authorized", reason: "Abono", payer_name: "Diaz Marcos", payer_email: "otro.mail@hotmail.com", amount: 39000, date_created: iso(-60), next_payment_date: iso(10), last_charge_date: iso(-20), last_charge_status: "processed", last_payment_status: "approved", last_payment_status_detail: null, last_retry_attempt: null, approved_count: 2, synced_at: iso(0) },
        { id: "mp4", company_id: null, company_name: null, status: "authorized", reason: "Abono", payer_name: null, payer_email: "javier@ejemplo.com", amount: 39000, date_created: iso(-60), next_payment_date: iso(10), last_charge_date: iso(-20), last_charge_status: "processed", last_payment_status: "approved", last_payment_status_detail: null, last_retry_attempt: null, approved_count: 2, synced_at: iso(0) },
        { id: "mp5", company_id: null, company_name: null, status: "authorized", reason: "Abono", payer_name: "Juan Perez", payer_email: "juanp@gmail.com", amount: 39000, date_created: iso(-60), next_payment_date: iso(10), last_charge_date: iso(-20), last_charge_status: "processed", last_payment_status: "approved", last_payment_status_detail: null, last_retry_attempt: null, approved_count: 2, synced_at: iso(0) }
      ];
    case "mp_sync_status": return { scheduled: true, last_run_at: iso(-0.02), last_result: null };
    case "list_scale_support_access": return [];
    case "scale_support_tools_enabled": return false;
    case "list_scale_support_reports": return scaleReports.map((r) => ({ ...r, user_name: "Cajero", connections: [], user_agent: "Chrome 153", log_text: r.log_text }));
    case "admin_scale_overview": return scaleOverview();
    case "admin_scale_company_detail": return scaleDetail(String(args.p_company_id));
    case "admin_scale_report_log": {
      const r = scaleReports.find((x) => x.id === args.p_report_id)!;
      // Como lo devuelve la base: ya limpio.
      return { id: r.id, company_id: r.company_id, company_name: r.company_name, branch_name: r.branch_name, created_at: r.created_at, resolved_at: r.resolved_at, note: r.note, user_agent: "Chrome 153", connections: [], log_text: r.log_text.replace(/"password":"[^"]*"/, '"password":"[oculto]"') };
    }
    case "set_scale_support_report_resolved": {
      const r = scaleReports.find((x) => x.id === args.p_id);
      if (r) r.resolved_at = args.p_resolved ? iso(0) : null;
      return null;
    }
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
      return { enabled: false, recipients: [], send_hour: 8, url_set: true, last_sent_on: null, last_run_at: null, last_result: null, cost_account_id: null, cost_per_message: null };
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
