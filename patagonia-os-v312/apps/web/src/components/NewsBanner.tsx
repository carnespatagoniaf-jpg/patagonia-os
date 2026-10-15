import { useState } from "react";
import { useAuth } from "../features/auth/AuthProvider";
import { can, canAccessPage, type Page, type Permission } from "../features/auth/permissions";
import { localDateIso } from "../features/shifts/format";
import { NEWS, visibleNews } from "./news";

/** Cartel de novedades (news.ts). "Entendido" lo oculta para esta persona en esta computadora. */
export function NewsBanner({ onPageChange }: { onPageChange: (page: Page) => void }) {
  const { profile } = useAuth();
  const storageKey = `patagonia-news-dismissed-${profile?.id ?? "anon"}`;
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[];
    } catch {
      return [];
    }
  });

  if (!profile) return null;
  const items = visibleNews(NEWS, (p) => can(profile, p as Permission), dismissed, localDateIso());
  if (items.length === 0) return null;

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // sin almacenamiento: se oculta igual hasta recargar
    }
  }

  return (
    <>
      {items.map((n) => (
        <div key={n.id} className="message" style={{ display: "grid", gap: 6 }}>
          <strong>🆕 {n.title}</strong>
          <span>{n.body}</span>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {n.page && canAccessPage(profile, n.page as Page) && (
              <button onClick={() => { dismiss(n.id); onPageChange(n.page as Page); }}>{n.pageLabel ?? "Ver"}</button>
            )}
            <button className="secondary" onClick={() => dismiss(n.id)}>Entendido</button>
          </span>
        </div>
      ))}
    </>
  );
}
