import type { ReactNode } from "react";
import { BarChart3, Beef, Boxes, FileText, HandCoins, LogOut, PackagePlus, ShoppingCart, TrendingUp, Users, Wallet } from "lucide-react";
import { useAuth } from "../features/auth/AuthProvider";

export type Page = "dashboard" | "inventory" | "purchases" | "shifts" | "treasury" | "employees" | "profitability" | "carcass" | "creditors" | "reports";

interface Props {
  page: Page;
  onPageChange: (page: Page) => void;
  children: ReactNode;
}

const items: Array<{ page: Page; label: string; icon: typeof BarChart3 }> = [
  { page: "dashboard", label: "Inicio", icon: BarChart3 },
  { page: "shifts", label: "Ventas", icon: ShoppingCart },
  { page: "inventory", label: "Stock", icon: Boxes },
  { page: "purchases", label: "Compras", icon: PackagePlus },
  { page: "treasury", label: "Tesorería", icon: Wallet },
  { page: "employees", label: "Empleados", icon: Users },
  { page: "profitability", label: "Rentabilidad", icon: TrendingUp },
  { page: "carcass", label: "Despiece", icon: Beef },
  { page: "creditors", label: "Deudas", icon: HandCoins },
  { page: "reports", label: "Reportes", icon: FileText }
];

export function Layout({ page, onPageChange, children }: Props) {
  const { profile, signOut } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">PATAGONIA OS</div>
          <div className="branch">
            {profile?.full_name ?? "Usuario"} · {profile?.role ?? "sin rol"}
          </div>
        </div>

        <nav>
          {items.map(({ page: target, label, icon: Icon }) => (
            <button
              key={target}
              className={page === target ? "nav-item active" : "nav-item"}
              onClick={() => onPageChange(target)}
            >
              <Icon size={19} />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item" onClick={() => void signOut()}>
            <LogOut size={19} />
            Salir
          </button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
