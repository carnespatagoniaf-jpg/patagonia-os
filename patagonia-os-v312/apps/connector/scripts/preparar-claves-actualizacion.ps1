# Prepara (UNA sola vez) las claves de la actualizacion automatica de Patagonia Scale Connect.
# Solo ASCII a proposito: PowerShell 5.1 lee los .ps1 sin BOM como ANSI.
#
#   powershell -ExecutionPolicy Bypass -File apps\connector\scripts\preparar-claves-actualizacion.ps1 `
#     [-Repo carnespatagoniaf-jpg/patagonia-os] [-SupabaseProyecto tayylvhfmoybchutybcz] [-ConStorage] [-Reemplazar]
#
# Que hace:
#   1. Genera un par Ed25519 nuevo. La clave PRIVADA no se muestra ni se guarda en ningun archivo: va directo al
#      secreto SCALE_CONNECT_UPDATE_KEY del repo (gh secret set, por la entrada estandar).
#   2. La clave PUBLICA queda como variable del repo SCALE_CONNECT_UPDATE_PUBKEY (el CI la mete en el ejecutable).
#   3. Con -SupabaseProyecto: variable SCALE_CONNECT_STORAGE_URL = https://<proyecto>.supabase.co (bucket
#      "scale-connect", lo crea la migracion 229).
#   4. Con -ConStorage: pide (sin mostrarla) la clave de servicio de Supabase y la carga como secreto
#      SCALE_CONNECT_STORAGE_KEY (Supabase -> Project Settings -> API Keys -> service_role o una "secret key").
#
# Hace falta: gh (con "gh auth login" hecho, con permiso de administrar secretos del repo) y Node 22.
# Si el secreto ya existe se niega: cambiar la clave deja a las PC instaladas sin poder actualizarse solas.
param(
  [string]$Repo = 'carnespatagoniaf-jpg/patagonia-os',
  [string]$SupabaseProyecto = '',
  [switch]$ConStorage,
  [switch]$Reemplazar
)
$ErrorActionPreference = 'Stop'

foreach ($cmd in @('gh', 'node')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Falta $cmd en esta PC." }
}
& gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'gh no tiene sesion: corre "gh auth login" primero.' }

$script = Join-Path $PSScriptRoot 'lib\keys-to-github.mjs'
$nodeArgs = @($script, '--repo', $Repo)
if ($Reemplazar) { $nodeArgs += '--reemplazar' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'No se cargaron las claves (ver el mensaje de arriba).' }

if ($SupabaseProyecto) {
  if ($SupabaseProyecto -notmatch '^[a-z0-9]{20}$') { throw "Proyecto de Supabase invalido: $SupabaseProyecto" }
  & gh variable set SCALE_CONNECT_STORAGE_URL --repo $Repo --body "https://$SupabaseProyecto.supabase.co"
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo cargar SCALE_CONNECT_STORAGE_URL.' }
  Write-Output "Variable SCALE_CONNECT_STORAGE_URL = https://$SupabaseProyecto.supabase.co"
}

if ($ConStorage) {
  $secure = Read-Host -AsSecureString 'Clave de servicio de Supabase (no se muestra)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if (-not $plain) { throw 'Clave vacia.' }
    # Por la entrada estandar: nunca en la linea de comandos.
    $plain | & gh secret set SCALE_CONNECT_STORAGE_KEY --repo $Repo
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo cargar SCALE_CONNECT_STORAGE_KEY.' }
    Write-Output 'Secreto SCALE_CONNECT_STORAGE_KEY cargado.'
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $plain = $null
  }
}

Write-Output ''
Write-Output 'Proximo paso: subir un tag scale-connect-vX.Y.Z. El CI arma el ejecutable con la clave publica, firma'
Write-Output 'latest.json, sube todo al bucket y crea el Release. Despues, publicar-X.Y.Z.sql en el editor SQL.'
