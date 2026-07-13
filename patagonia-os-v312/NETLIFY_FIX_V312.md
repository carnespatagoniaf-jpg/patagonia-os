# Patagonia OS V3.1.2

Corrección del error de Netlify:

`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:": workspace:*`

Los paquetes internos ahora usan una versión compatible con npm workspaces.
Después de copiar esta versión al repositorio:

1. Commit to main
2. Push origin
3. Netlify iniciará un deploy automáticamente
