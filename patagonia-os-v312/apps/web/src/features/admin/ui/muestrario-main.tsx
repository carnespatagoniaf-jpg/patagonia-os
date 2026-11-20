import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Muestrario } from "./Muestrario";

// Entrada aparte (muestrario.html): no carga la app, ni Supabase, ni los estilos de las carnicerías.
document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Muestrario />
  </StrictMode>
);
