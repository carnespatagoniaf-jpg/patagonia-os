import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../../styles.css";
import { AdminCreateClient } from "../AdminCreateClient";

// Vista de prueba del panel de plataforma con datos de EJEMPLO (dev/demo-supabase.ts). No toca ninguna base.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminCreateClient />
  </StrictMode>
);
