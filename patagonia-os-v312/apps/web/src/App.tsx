import { useState } from "react";
import { Layout, type Page } from "./components/Layout";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Inventory } from "./features/inventory/Inventory";
import { Purchases } from "./features/purchases/Purchases";
import { Shifts } from "./features/shifts/Shifts";
import { Treasury } from "./features/shifts/Treasury";
import { Reports } from "./features/shifts/Reports";
import { Employees } from "./features/employees/Employees";
import { Profitability } from "./features/profitability/Profitability";
import { Carcass } from "./features/carcass/Carcass";
import { Creditors } from "./features/creditors/Creditors";
import { Login } from "./features/auth/Login";
import { useAuth } from "./features/auth/AuthProvider";
import { isSupabaseConfigured } from "./lib/supabase";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const { loading, session, profile } = useAuth();

  if (loading) return <main className="loading-page">Cargando Patagonia OS…</main>;

  if (isSupabaseConfigured && (!session || !profile)) {
    return <Login />;
  }

  return (
    <Layout page={page} onPageChange={setPage}>
      {page === "dashboard" && <Dashboard />}
      {page === "inventory" && <Inventory />}
      {page === "purchases" && <Purchases />}
      {page === "shifts" && <Shifts />}
      {page === "treasury" && <Treasury />}
      {page === "employees" && <Employees />}
      {page === "profitability" && <Profitability />}
      {page === "carcass" && <Carcass />}
      {page === "creditors" && <Creditors />}
      {page === "reports" && <Reports />}
    </Layout>
  );
}
