// Demo de Pedidos para mostrar con un link (borrador de Netlify, nunca se publica en el sitio real).
// Compila la web SIN base de datos (modo demostración), entrando como cajera con la pantalla 'pedidos',
// y le agrega pedidos de ejemplo guardados en el navegador. No cambia ningún archivo del repo: trabaja sobre una copia.
import { execSync } from "node:child_process";
import fs from "node:fs";

const auth = "apps/web/src/features/auth/AuthProvider.tsx";
const original = fs.readFileSync(auth, "utf8");
const demo = original.replace(
  /full_name: "Demo",\n  role: "owner",\n  active: true\n\};/,
  'full_name: "Cajera demo",\n  role: "cashier",\n  active: true,\n  features: ["pedidos"]\n};'
);
if (demo === original) throw new Error("No se encontró el perfil de demostración en AuthProvider.tsx");
try {
  fs.writeFileSync(auth, demo);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("VITE_")) delete env[k];
  execSync("npm run build -w @patagonia/domain", { stdio: "inherit", env });
  execSync("npx vite build --outDir ../../demo-dist --emptyOutDir", { stdio: "inherit", env, cwd: "apps/web" });
  const seed = fs.readFileSync("scripts/demo/pedidos-seed.html", "utf8");
  const index = "demo-dist/index.html";
  // Sin Google Tag en la demo, y con los pedidos de ejemplo antes de que arranque la web.
  const html = fs.readFileSync(index, "utf8")
    .replace(/<!-- Google tag[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/, "")
    .replace("<title>Patagonia OS</title>", "<title>Pedidos - demo</title>\n" + seed);
  fs.writeFileSync(index, html);
  fs.writeFileSync("demo-dist/robots.txt", "User-agent: *\nDisallow: /\n");
} finally {
  fs.writeFileSync(auth, original);
}
