# Armar el paquete del laboratorio Systel

Herramienta para validar escrituras en una Cuora Max de PRUEBA (ver `docs/SYSTEL_DIAGNOSTICO_LOS_GRINGOS.md`, secciones H a J). No es la versión de producción. En producción la escritura Systel está bloqueada.

Desde `patagonia-os-v312/apps/web`, en Git Bash:

```bash
L=../../../laboratorio-systel
VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= VITE_SENTRY_DSN= VITE_HELP_CHAT= VITE_SYSTEL_LAB=1 npx vite build --outDir "$L/app" --emptyOutDir
```

Después:
1. Quitar del `app/index.html` el bloque "Google tag (gtag.js)". El laboratorio no manda nada a internet.
2. Copiar a la carpeta `servidor.ps1`, `INICIAR-LABORATORIO.bat` y `LEEME.txt` (están en esta carpeta).
3. Escribir `VERSION.txt` con el commit.
4. Comprimir todo junto.

Al armarlo, verificar:
- que `app/assets` tenga el texto "LABORATORIO Systel";
- que no aparezca ninguna URL `https://…supabase.co`;
- que no quede `gtag`.
