import { useEffect, useState } from "react";
import { lazyPage, PageFrame, prefetchPages } from "./components/LazyPage";
import { Layout, type Page } from "./components/Layout";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Sale } from "./features/sale/Sale";
import { Login } from "./features/auth/Login";
import { ResetPassword } from "./features/auth/ResetPassword";
import { useAuth } from "./features/auth/AuthProvider";
import { canAccessPage, firstAccessiblePage } from "./features/auth/permissions";
import { BranchProvider } from "./features/branches/BranchProvider";
import { isSupabaseConfigured } from "./lib/supabase";
import { setSerialTabPage } from "./features/inventory/kretz/serial-tabs";
import { trackPageVisit } from "./lib/page-usage";

// Mostrador e Inicio van en el paquete principal; el resto se baja al abrirlo (ver LazyPage.tsx).
const Inventory = lazyPage(() => import("./features/inventory/Inventory"), "Inventory");
const ProductsLookup = lazyPage(() => import("./features/products/ProductsLookup"), "ProductsLookup");
const Purchases = lazyPage(() => import("./features/purchases/Purchases"), "Purchases");
const Shifts = lazyPage(() => import("./features/shifts/Shifts"), "Shifts");
const Treasury = lazyPage(() => import("./features/shifts/Treasury"), "Treasury");
const Reports = lazyPage(() => import("./features/shifts/Reports"), "Reports");
const AccountsReport = lazyPage(() => import("./features/accounts/AccountsReport"), "AccountsReport");
const Expenses = lazyPage(() => import("./features/accounts/Expenses"), "Expenses");
const Employees = lazyPage(() => import("./features/employees/Employees"), "Employees");
const Profitability = lazyPage(() => import("./features/profitability/Profitability"), "Profitability");
const Carcass = lazyPage(() => import("./features/carcass/Carcass"), "Carcass");
const Branches = lazyPage(() => import("./features/branches/Branches"), "Branches");
const Recipes = lazyPage(() => import("./features/recipes/Recipes"), "Recipes");
const Scales = lazyPage(() => import("./features/scales/Scales"), "Scales");
const Reconciliation = lazyPage(() => import("./features/reconciliation/Reconciliation"), "Reconciliation");
const Cheques = lazyPage(() => import("./features/cheques/Cheques"), "Cheques");
const Invoicing = lazyPage(() => import("./features/invoicing/Invoicing"), "Invoicing");
const Creditors = lazyPage(() => import("./features/creditors/Creditors"), "Creditors");
const Customers = lazyPage(() => import("./features/customers/Customers"), "Customers");
const Export = lazyPage(() => import("./features/export/Export"), "Export");
const ImportData = lazyPage(() => import("./features/import/ImportData"), "ImportData");
const Users = lazyPage(() => import("./features/users/Users"), "Users");
const AuditLog = lazyPage(() => import("./features/audit/AuditLog"), "AuditLog");
const AdminCreateClient = lazyPage(() => import("./features/admin/AdminCreateClient"), "AdminCreateClient");

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const { loading, session, profile, passwordRecovery, isPlatformAdmin } = useAuth();

  useEffect(() => {
    setSerialTabPage(page);
  }, [page]);

  useEffect(() => {
    prefetchPages();
  }, []);

  // Qué pantallas usa cada empresa (pestaña Resumen del panel de plataforma).
  useEffect(() => {
    if (profile && canAccessPage(profile, page)) trackPageVisit(page);
  }, [profile, page]);

  useEffect(() => {
    if (profile && !canAccessPage(profile, page)) {
      setPage(firstAccessiblePage(profile));
    }
  }, [profile, page]);

  if (loading) return <main className="loading-page">Cargando Patagonia OS…</main>;

  if (isSupabaseConfigured && passwordRecovery) {
    return <ResetPassword />;
  }

  if (isSupabaseConfigured && session && isPlatformAdmin && !profile) {
    return <PageFrame><AdminCreateClient /></PageFrame>;
  }

  if (isSupabaseConfigured && (!session || !profile)) {
    return <Login />;
  }

  const allowed = canAccessPage(profile, page);

  return (
    <BranchProvider>
      <Layout page={page} onPageChange={setPage}>
        {!allowed && (
          <div className="message warning">No tenés permiso para ver esta sección. Consultá con el dueño o administrador.</div>
        )}
        <PageFrame key={page}>
        {allowed && page === "dashboard" && <Dashboard />}
        {allowed && page === "sale" && <Sale />}
        {allowed && page === "products" && <ProductsLookup />}
        {allowed && page === "inventory" && <Inventory />}
        {allowed && page === "purchases" && <Purchases />}
        {allowed && page === "shifts" && <Shifts />}
        {allowed && page === "treasury" && <Treasury />}
        {allowed && page === "employees" && <Employees />}
        {allowed && page === "profitability" && <Profitability />}
        {allowed && page === "carcass" && <Carcass />}
        {allowed && page === "branches" && <Branches />}
        {allowed && page === "recipes" && <Recipes />}
        {allowed && page === "scales" && <Scales />}
        {allowed && page === "reconciliation" && <Reconciliation />}
        {allowed && page === "cheques" && <Cheques />}
        {allowed && page === "invoicing" && <Invoicing />}
        {allowed && page === "creditors" && <Creditors />}
        {allowed && page === "customers" && <Customers />}
        {allowed && page === "reports" && <Reports />}
        {allowed && page === "accounts" && <AccountsReport />}
        {allowed && page === "expenses" && <Expenses />}
        {allowed && page === "export" && <Export />}
        {allowed && page === "import" && <ImportData />}
        {allowed && page === "users" && <Users />}
        {allowed && page === "audit" && <AuditLog />}
        </PageFrame>
      </Layout>
    </BranchProvider>
  );
}
