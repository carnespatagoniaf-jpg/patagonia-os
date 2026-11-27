// Versiones y hashes FIJOS de lo que el empaquetado descarga.
// Si se cambia una versión, se cambia su hash en el mismo commit (y se anota de dónde salió).

// WinSW v3 (envoltorio del servicio). El proyecto no publica hashes de sus releases:
// el SHA-256 se calculó al bajarlo el 27/11/2026 y queda fijo. Si GitHub llegara a servir
// otro archivo con el mismo nombre, el build se frena.
export const WINSW = {
  version: "v3.0.0-alpha.11",
  url: "https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe",
  sha256: "a2daa6a33a9c2b791ae31d9092e7935c339d1e03e89bfb747618ce2f4e819e20",
};

// Node 22 LTS portable (x64) con el que se arma scale-connect.exe cuando el Node que corre
// el script no es 22.x. Hash tomado de https://nodejs.org/dist/v22.23.5/SHASUMS256.txt
export const NODE22 = {
  version: "v22.23.5",
  url: "https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip",
  sha256: "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3",
  folder: "node-v22.23.5-win-x64",
};

// Fusible de Node SEA (el mismo en Node 20 a 24).
export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
