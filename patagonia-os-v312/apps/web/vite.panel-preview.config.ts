import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Vista de prueba del panel de plataforma (rediseño, noviembre 2026): abre /panel-preview.html con datos de EJEMPLO.
 * Cambia lib/supabase y auth/AuthProvider por los de features/admin/dev, así no hace falta la cuenta real
 * ni se toca staging o producción. Uso: `npx vite --config vite.panel-preview.config.ts`.
 */
const demoSupabase = fileURLToPath(new URL("./src/features/admin/dev/demo-supabase.ts", import.meta.url));
const demoAuth = fileURLToPath(new URL("./src/features/admin/dev/demo-auth.tsx", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "panel-preview-demo-data",
      enforce: "pre",
      resolveId(source) {
        if (/(^|\/)lib\/supabase$/.test(source)) return demoSupabase;
        if (/(^|\/)auth\/AuthProvider$/.test(source)) return demoAuth;
        return null;
      }
    }
  ],
  define: { __APP_BUILD__: JSON.stringify("panel-preview") },
  server: { port: 5192, strictPort: true }
});
