import { useEffect, useState } from "react";
import { Layout, type Page } from "./components/Layout";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Inventory } from "./features/inventory/Inventory";
import { Sale } from "./features/sale/Sale";
import { ProductsLookup } from "./features/products/ProductsLookup";
import { Purchases } from "./features/purchases/Purchases";
import { Shifts } from "./features/shifts/Shifts";
import { Treasury } from "./features/shifts/Treasury";
import { Reports } from "./features/shifts/Reports";
import { Employees } from "./features/employees/Employees";
import { Profitability } from "./features/profitability/Profitability";
import { Carcass } from "./features/carcass/Carcass";
import { Creditors } from "./features/creditors/Creditors";
import { Customers } from "./features/customers/Customers";
import { Users } from "./features/users/Users";
import { AuditLog } from "./features/audit/AuditLog";
import { Login } from "./features/auth/Login";
import { ResetPassword } from "./features/auth/ResetPassword";
import { AdminCreateClient } from "./features/admin/AdminCreateClient";
import { useAuth } from "./features/auth/AuthProvider";
import { canAccessPage, firstAccessiblePage } from "./features/auth/permissions";
import { BranchProvider } from "./features/branches/BranchProvider";
import { isSupabaseConfigured } from "./lib/supabase";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const { loading, session, profile, passwordRecovery, isPlatformAdmin } = useAuth();

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
    return <AdminCreateClient />;
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
        {allowed && page === "creditors" && <Creditors />}
        {allowed && page === "customers" && <Customers />}
        {allowed && page === "reports" && <Reports />}
        {allowed && page === "users" && <Users />}
        {allowed && page === "audit" && <AuditLog />}
      </Layout>
    </BranchProvider>
  );
}
