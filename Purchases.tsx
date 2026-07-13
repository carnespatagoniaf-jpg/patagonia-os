import { useState } from "react";
import { Layout, type Page } from "./components/Layout";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Pos } from "./features/pos/Pos";
import { Inventory } from "./features/inventory/Inventory";
import { Purchases } from "./features/purchases/Purchases";
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
      {page === "pos" && <Pos />}
      {page === "inventory" && <Inventory />}
      {page === "purchases" && <Purchases />}
    </Layout>
  );
}
