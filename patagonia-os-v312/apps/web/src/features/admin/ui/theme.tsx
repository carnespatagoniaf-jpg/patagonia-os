import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import "./admin-ui.css";

export type ThemeChoice = "light" | "dark" | "auto";
export type Theme = "light" | "dark";

const STORAGE_KEY = "patagonia-admin-theme";
const ThemeContext = createContext<{ theme: Theme; choice: ThemeChoice; setChoice: (c: ThemeChoice) => void }>({
  theme: "light",
  choice: "auto",
  setChoice: () => undefined
});

function readChoice(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  } catch {
    return "auto";
  }
}

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Contenedor del panel de plataforma: aplica los colores del sistema de diseño (`.pa`) y el modo claro/oscuro.
 * "auto" sigue al teléfono/computadora. La elección queda guardada en este navegador.
 */
export function AdminThemeRoot({ children, className = "", forceLight }: { children: ReactNode; className?: string; /** Pestañas que todavía no tienen el diseño nuevo: siempre en claro. */ forceLight?: boolean }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function setChoice(next: ThemeChoice) {
    setChoiceState(next);
    try {
      if (next === "auto") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Navegador sin almacenamiento: vale solo mientras esté abierta la pestaña.
    }
  }

  const theme = forceLight ? "light" : choice === "auto" ? system : choice;
  return (
    <ThemeContext.Provider value={{ theme, choice, setChoice }}>
      <div className={`pa ${className}`.trim()} data-pa-theme={theme}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useAdminTheme() {
  return useContext(ThemeContext);
}
