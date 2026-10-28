import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Qué versión de la web tenía el cliente cuando mandó un diagnóstico a soporte (auditoría de balanzas 28/10).
  define: { __APP_BUILD__: JSON.stringify(new Date().toISOString()) },
  server: { port: 5173 }
});
