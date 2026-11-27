#!/bin/bash
# Solo corre en las sesiones de Claude en la nube (claude.ai/code o la app del celular).
# En la PC no hace nada.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR/patagonia-os-v312" || exit 0
npm ci --no-audit --no-fund > /tmp/preparar-nube.log 2>&1 || echo "npm ci falló, ver /tmp/preparar-nube.log" >&2
exit 0
