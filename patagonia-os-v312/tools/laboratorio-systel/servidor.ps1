# Laboratorio Systel (Patagonia OS) - servidor local, solo en esta PC (127.0.0.1).
# No necesita instalar nada ni permisos de administrador. Cerrar la ventana para terminar.
param([int]$Port = 8137)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app'))
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host ""
Write-Host "  LABORATORIO SYSTEL - solo para una balanza de PRUEBA"
Write-Host "  Abierto en http://127.0.0.1:$Port/  (Chrome o Edge)"
Write-Host "  Cerrar esta ventana para terminar."
Write-Host ""
Start-Process "http://127.0.0.1:$Port/"
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.json' = 'application/json'
  '.webmanifest' = 'application/manifest+json'; '.woff2' = 'font/woff2'; '.txt' = 'text/plain; charset=utf-8'
  '.ps1' = 'text/plain; charset=utf-8'; '.bat' = 'text/plain; charset=utf-8'
}
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($root) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) { $full = Join-Path $root 'index.html' }
    $ext = [IO.Path]::GetExtension($full).ToLower()
    if ($types.ContainsKey($ext)) { $ctx.Response.ContentType = $types[$ext] } else { $ctx.Response.ContentType = 'application/octet-stream' }
    $bytes = [IO.File]::ReadAllBytes($full)
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
