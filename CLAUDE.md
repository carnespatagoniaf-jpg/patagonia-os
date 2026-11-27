# Patagonia OS

El sistema está en `patagonia-os-v312/`. Antes de cambiar algo, leé `patagonia-os-v312/CLAUDE.md`: tiene todas las reglas del proyecto.

## Sesiones en la nube (claude.ai/code o la app del celular)

- Al arrancar, `.claude/hooks/preparar-nube.sh` instala las dependencias (`npm ci` en `patagonia-os-v312`).
- Supabase llega por `.mcp.json`: `supabase` (producción, token `SUPABASE_ACCESS_TOKEN`) y `supabase-pruebas` (staging, token `SUPABASE_STAGING_ACCESS_TOKEN`). Los dos tokens se cargan como variables del entorno de la nube, nunca en el repo. Si falta alguno, avisale al dueño en vez de inventar otro camino.
- Donde `patagonia-os-v312/CLAUDE.md` dice "variable de entorno de Windows", en la nube es la misma variable del entorno.
- Las reglas de publicación no cambian: staging primero y producción solo a las 00:00 (hora de Argentina). Para publicar un arreglo se abre un PR a `main`; no se publica desde la sesión.
