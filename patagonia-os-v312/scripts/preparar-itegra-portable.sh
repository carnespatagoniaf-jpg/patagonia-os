#!/usr/bin/env bash
# Prepara una copia PORTÁTIL de iTegra para capturar lo que manda a una Kretz Aura
# (ver docs/AURA_CAPTURA_ITEGRA.md). NO ejecuta iTegra ni su instalador: solo
# descarga, verifica y extrae archivos. Sin instalador no hay drivers, servicio
# de Windows ni cambios en el registro.
#
# Uso (Git Bash):  bash scripts/preparar-itegra-portable.sh <carpeta destino>
# Necesita unos 1,6 GB libres durante la preparación y deja unos 650 MB.
set -euo pipefail

DEST="${1:?Indicá la carpeta destino}"
# Fuente oficial: carpeta "iTegra para Windows" enlazada en https://www.kretz.com.ar/software
URL="https://drive.usercontent.google.com/download?id=1zAB0bhs-qxjtosq83Bsz1mZ-2RrGJ7f7&export=download&confirm=t"
SIZE=500450686
SHA256="26DFC99B400F4290AF11D31972691F9366910EA1FF74D4F5A2E930CF627DC881"

mkdir -p "$DEST"
cd "$DEST"
echo "Descargando iTegra_setup_4-148.exe (477 MB) de la fuente oficial…"
curl -sSL -o iTegra_setup_4-148.exe "$URL"
[ "$(stat -c %s iTegra_setup_4-148.exe)" = "$SIZE" ] || { echo "Tamaño inesperado: no se usa"; exit 1; }
[ "$(sha256sum iTegra_setup_4-148.exe | cut -d' ' -f1 | tr a-f A-F)" = "$SHA256" ] || { echo "Huella (SHA-256) distinta: no se usa"; exit 1; }

echo "Extrayendo (sin ejecutar)…"
unzip -o -q iTegra_setup_4-148.exe "InstallerData/Disk1/InstData/Resource1.zip" "Windows/resource/jre/*" -d x
rm -f iTegra_setup_4-148.exe
unzip -o -q x/InstallerData/Disk1/InstData/Resource1.zip "C_/Archivos de trabajo/kSolutions/*" -d tmp
rm -f x/InstallerData/Disk1/InstData/Resource1.zip
mv "tmp/C_/Archivos de trabajo/kSolutions" kSolutions
mv x/Windows/resource/jre jreK
rm -rf tmp x
# No se copian ni se ejecutan los instaladores de drivers que trae (FTDI CDM20814, NXP LPCXpresso, devcon).
rm -f kSolutions/iTegra/CDM20814_Setup.exe kSolutions/iTegra/LPCXpresso_Link2_USB_driver_package.exe
rm -rf kSolutions/iTegra/devcon kSolutions/iTegra/drivers kSolutions/DataGate/LPCXpresso_Link2_USB_driver_package.exe

echo "Listo. iTegra portátil en: $DEST/kSolutions/iTegra (se abre con iTegra.bat, SOLO con autorización)."
