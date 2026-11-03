import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Qué versión de la web tenía el cliente cuando mandó un diagnóstico a soporte (auditoría de balanzas 28/10).
const APP_BUILD = new Date().toISOString();
// Commit publicado: "Publicar" lo lee de /version.json para no volver a publicar lo mismo cada noche.
const APP_COMMIT = process.env.GITHUB_SHA ?? process.env.COMMIT_REF ?? null;

export default defineConfig({
  plugins: [
    react(),
    // version.json con la misma versión: la web abierta lo consulta y avisa cuando hay una nueva publicada
    // (auditoría 29/10/2026: una PC seguía con una pestaña de antes del 28/10, dando errores).
    {
      name: "patagonia-version-json",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: APP_BUILD, commit: APP_COMMIT }) });
      }
    }
  ],
  define: { __APP_BUILD__: JSON.stringify(APP_BUILD) },
  server: { port: 5173 }
});
