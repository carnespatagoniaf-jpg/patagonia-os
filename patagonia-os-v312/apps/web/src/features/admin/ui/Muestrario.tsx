import { useState } from "react";
import { Building2, CreditCard, LayoutDashboard, LifeBuoy, MessageCircle, Plus, Trash2, Users, Wallet } from "lucide-react";
import { Alert, Badge, BrandMark, Button, Card, Checkbox, ConfirmDialog, EmptyState, Field, Input, Kpi, Modal, Select, Skeleton, Tabs, Textarea, ThemeToggle, type Tone } from "./components";
import { DataTable, type Column } from "./DataTable";
import { AdminThemeRoot } from "./theme";

/**
 * Muestrario del sistema de diseño del panel (Etapa 2). Solo para mirar: datos de EJEMPLO, no toca la base.
 * Se abre en desarrollo en /muestrario.html; no entra en la web publicada.
 */

type Example = { id: string; n: number; name: string; owner: string; city: string; plan: string; status: "paga" | "debe" | "prueba" | "riesgo"; daysNoSale: number | null; paidUntil: string | null; fee: number };

const EXAMPLES: Example[] = [
  { id: "1", n: 1, name: "Carnicería El Novillo", owner: "Ana Pérez", city: "Trelew, Chubut", plan: "Full", status: "paga", daysNoSale: 0, paidUntil: "2026-12-12", fee: 39000 },
  { id: "2", n: 4, name: "Granja La Esquina", owner: "Marcos Díaz", city: "Neuquén", plan: "Estándar", status: "debe", daysNoSale: 1, paidUntil: "2026-11-10", fee: 39000 },
  { id: "3", n: 7, name: "Fiambrería Don Tito", owner: "Rubén Sosa", city: "Río Gallegos, Santa Cruz", plan: "Estándar", status: "riesgo", daysNoSale: 9, paidUntil: "2026-11-28", fee: 39000 },
  { id: "4", n: 12, name: "Súper Los Andes", owner: "Lucía Gómez", city: "San Rafael, Mendoza", plan: "Full", status: "prueba", daysNoSale: null, paidUntil: null, fee: 39000 },
  { id: "5", n: 15, name: "Pollería Doña Rosa", owner: "Rosa Medina", city: "Viedma, Río Negro", plan: "Básico", status: "paga", daysNoSale: 2, paidUntil: "2027-01-05", fee: 39000 }
];

const STATUS: Record<Example["status"], { label: string; tone: Tone }> = {
  paga: { label: "Al día", tone: "ok" },
  debe: { label: "Debe", tone: "danger" },
  prueba: { label: "En prueba", tone: "info" },
  riesgo: { label: "Dejando de usarlo", tone: "warn" }
};

const money = (v: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(v);
const dayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const COLUMNS: Column<Example>[] = [
  { key: "n", header: "N.º", render: (r) => r.n, sortValue: (r) => r.n, align: "right", hideOn: "sm" },
  { key: "name", header: "Cliente", main: true, render: (r) => <div><strong>{r.name}</strong><div className="pa-muted" style={{ fontSize: 12 }}>{r.owner}</div></div>, sortValue: (r) => r.name },
  { key: "city", header: "Ciudad", render: (r) => r.city, sortValue: (r) => r.city, hideOn: "md" },
  { key: "status", header: "Estado", render: (r) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>, sortValue: (r) => r.status, csvValue: (r) => STATUS[r.status].label },
  { key: "sale", header: "Última venta", render: (r) => (r.daysNoSale === null ? <span className="pa-muted">Nunca</span> : r.daysNoSale === 0 ? "Hoy" : `Hace ${r.daysNoSale} días`), sortValue: (r) => r.daysNoSale ?? 9999, firstDir: "desc", csvValue: (r) => r.daysNoSale ?? "" },
  { key: "until", header: "Pagado hasta", render: (r) => (r.paidUntil ? dayMonth(r.paidUntil) : "-"), sortValue: (r) => r.paidUntil, hideOn: "sm" },
  { key: "fee", header: "Abono", render: (r) => money(r.fee), sortValue: (r) => r.fee, align: "right" }
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 13, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--pa-muted)" }}>{title}</h2>
      {children}
    </section>
  );
}

function Contents() {
  const [tab, setTab] = useState<"resumen" | "clientes" | "ventas" | "finanzas" | "soporte">("clientes");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px max(16px, env(safe-area-inset-right)) 48px max(16px, env(safe-area-inset-left))", display: "grid", gap: 28 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <BrandMark suffix="Panel" />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ThemeToggle />
          <Button icon={Plus} onClick={() => setModalOpen(true)}>Nuevo cliente</Button>
        </div>
      </header>

      <Alert tone="info" title="Muestrario del diseño nuevo">Todo lo que ves acá son datos de ejemplo. Sirve para mirar colores, letras y botones antes de aplicarlos a tu panel.</Alert>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "resumen", label: "Resumen", icon: LayoutDashboard },
          { key: "clientes", label: "Clientes", icon: Building2 },
          { key: "ventas", label: "Ventas", icon: Users },
          { key: "finanzas", label: "Finanzas", icon: Wallet },
          { key: "soporte", label: "Soporte", icon: LifeBuoy, count: 2 }
        ]}
      />

      <Section title="Números clave">
        <div className="pa-kpis">
          <Kpi label="Cobrado en noviembre" value={money(585000)} delta={12} deltaLabel="vs octubre" />
          <Kpi label="Clientes que pagan" value="15" hint="de 17 activos" />
          <Kpi label="Bajas del mes" value="1" delta={100} deltaLabel="vs octubre" goodWhenUp={false} />
          <Kpi label="Vencido sin cobrar" value={money(78000)} hint="2 clientes" />
        </div>
      </Section>

      <Section title="Tabla de clientes (buscar, filtrar, ordenar, bajar a Excel)">
        <DataTable
          rows={EXAMPLES}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          searchText={(r) => `${r.n} ${r.name} ${r.owner} ${r.city}`}
          searchPlaceholder="Buscar por número, negocio, dueño o ciudad"
          filters={[
            { key: "debe", label: "Deben", test: (r) => r.status === "debe" },
            { key: "riesgo", label: "En riesgo", test: (r) => r.status === "riesgo" },
            { key: "prueba", label: "En prueba", test: (r) => r.status === "prueba" }
          ]}
          defaultSort={{ key: "sale", dir: "desc" }}
          exportName="clientes-ejemplo"
        />
      </Section>

      <Section title="Avisos">
        <div style={{ display: "grid", gap: 8 }}>
          <Alert tone="warn" title="Fiambrería Don Tito está dejando de usarlo" action={<Button variant="whatsapp" size="sm" icon={MessageCircle}>Escribirle por WhatsApp</Button>}>
            La semana pasada hizo 312 ventas y esta semana lleva 41.
          </Alert>
          <Alert tone="danger" title="Granja La Esquina debe el abono">Venció el 10/11. Son {money(39000)}.</Alert>
          <Alert tone="ok" title="Pago registrado">Carnicería El Novillo queda pagado hasta el 12/12.</Alert>
        </div>
      </Section>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card title="Botones" subtitle="Uno principal por pantalla; el resto, secundarios.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button>Guardar pago</Button>
            <Button variant="secondary">Ver pagos</Button>
            <Button variant="ghost">Más opciones</Button>
            <Button variant="whatsapp" icon={MessageCircle}>Cobrar por WhatsApp</Button>
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmOpen(true)}>Borrar cliente</Button>
            <Button loading={saving} onClick={() => { setSaving(true); window.setTimeout(() => setSaving(false), 1500); }}>{saving ? "Guardando…" : "Probar guardando"}</Button>
            <Button size="sm" variant="secondary">Chico</Button>
            <Button size="lg" icon={CreditCard}>Grande</Button>
          </div>
        </Card>

        <Card title="Campos" subtitle="Rótulo arriba, ayuda o error abajo.">
          <div className="pa-form-grid">
            <Field label="Nombre del negocio">{(id) => <Input id={id} defaultValue="Carnicería El Novillo" />}</Field>
            <Field label="Plan" hint="Todos cuestan $39.000 por local">{(id) => <Select id={id} defaultValue="full"><option value="estandar">Estándar</option><option value="full">Full</option></Select>}</Field>
            <Field label="Email del dueño" error="Falta el email">{(id) => <Input id={id} type="email" invalid placeholder="nombre@mail.com" />}</Field>
            <Field label="Monto">{(id) => <Input id={id} inputMode="decimal" defaultValue="39.000" className="pa-num" />}</Field>
          </div>
          <Field label="Nota">{(id) => <Textarea id={id} placeholder="Ej.: pagó por transferencia" />}</Field>
          <Checkbox label="Pase libre (sin cobro)" />
        </Card>

        <Card title="Etiquetas de estado">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Badge tone="ok">Al día</Badge>
            <Badge tone="warn">Vence en 3 días</Badge>
            <Badge tone="danger">Debe</Badge>
            <Badge tone="info">En prueba</Badge>
            <Badge tone="brand" dot={false}>Full</Badge>
            <Badge dot={false}>Sin pagos</Badge>
          </div>
        </Card>

        <Card title="Cargando">
          <Skeleton lines={4} />
        </Card>

        <Card title="Sin datos">
          <EmptyState icon={Users} title="Todavía no hay interesados" action={<Button size="sm" icon={Plus}>Cargar el primero</Button>}>
            Los que te escriben por Kommo aparecen acá solos.
          </EmptyState>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="¿Borrar Pollería Doña Rosa?"
        message="Se borra para siempre y no se puede deshacer. Si ya tiene ventas o productos cargados, el sistema no lo deja borrar."
        confirmLabel="Borrar para siempre"
        danger
        typeToConfirm="Pollería Doña Rosa"
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />

      <Modal
        open={modalOpen}
        title="Dar de alta un cliente"
        onClose={() => setModalOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={() => setModalOpen(false)}>Crear cliente</Button></>}
      >
        <div className="pa-form-grid">
          <Field label="Nombre del negocio">{(id) => <Input id={id} />}</Field>
          <Field label="Rubro">{(id) => <Select id={id}><option>Carnicería</option><option>Fiambrería</option><option>Supermercado</option><option>Pollería</option></Select>}</Field>
          <Field label="Nombre del dueño">{(id) => <Input id={id} />}</Field>
          <Field label="Teléfono">{(id) => <Input id={id} inputMode="tel" />}</Field>
        </div>
      </Modal>
    </div>
  );
}

export function Muestrario() {
  return (
    <AdminThemeRoot className="pa-page">
      <Contents />
    </AdminThemeRoot>
  );
}
