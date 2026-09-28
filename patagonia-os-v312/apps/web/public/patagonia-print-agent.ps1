# Patagonia OS - programa de impresion local (una sola vez por PC).
#
# Problema que resuelve: Chrome no puede hablarle directo a una impresora
# termica cuando Windows ya le puso un driver (error "Access denied"), y el
# dialogo de impresion de Windows usa ese driver -- si es el equivocado, la
# termica imprime basura sin fin. Este programa evita las dos cosas: escucha
# SOLO en esta PC (127.0.0.1:9101) y manda los bytes ESC/POS que arma el
# sistema directo a la cola de Windows en modo RAW, o sea, sin pasar por el
# driver. Funciona con cualquier termica ESC/POS de cualquier marca.
#
# Seguridad: solo acepta pedidos de un navegador que venga de
# *.patagoniasystem.com.ar (o localhost, para desarrollo), y solo imprime en
# impresoras que ya estan instaladas en Windows. No abre nada hacia afuera.
#
# Se instala con instalar-impresora.bat (lo baja de este mismo sitio y lo
# deja arrancando con Windows). Mantener este archivo en ASCII: PowerShell 5.1
# lee mal los acentos de un archivo UTF-8 sin BOM.

$ErrorActionPreference = "Stop"
$Port = 9101
$AgentVersion = 1

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class PatagoniaRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

  // Devuelve "OK" o un texto con el error de Windows.
  public static string Send(string printerName, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero)) return "No se pudo abrir la impresora (error " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFOW di = new DOCINFOW();
      di.pDocName = "Ticket Patagonia OS";
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) return "Windows no acepto el trabajo de impresion (error " + Marshal.GetLastWin32Error() + ")";
      try {
        if (!StartPagePrinter(h)) return "Windows no abrio la pagina (error " + Marshal.GetLastWin32Error() + ")";
        int written;
        bool ok = WritePrinter(h, bytes, bytes.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != bytes.Length) return "No se pudo enviar el ticket a la impresora (error " + Marshal.GetLastWin32Error() + ")";
      } finally {
        EndDocPrinter(h);
      }
    } finally {
      ClosePrinter(h);
    }
    return "OK";
  }
}
'@

function Test-AllowedOrigin([string]$origin) {
  if (-not $origin) { return $false }
  if ($origin -match '^https://([a-z0-9-]+\.)*patagoniasystem\.com\.ar$') { return $true }
  if ($origin -match '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$') { return $true }
  return $false
}

function Send-Json($ctx, [int]$status, $obj, [string]$origin) {
  $res = $ctx.Response
  $res.StatusCode = $status
  if ($origin -and (Test-AllowedOrigin $origin)) {
    $res.Headers["Access-Control-Allow-Origin"] = $origin
    $res.Headers["Vary"] = "Origin"
    $res.Headers["Access-Control-Allow-Private-Network"] = "true"
  }
  $res.ContentType = "application/json; charset=utf-8"
  $json = ConvertTo-Json -InputObject $obj -Compress
  $buf = [System.Text.Encoding]::UTF8.GetBytes($json)
  $res.ContentLength64 = $buf.Length
  $res.OutputStream.Write($buf, 0, $buf.Length)
  $res.OutputStream.Close()
}

# Driver que acepta bytes crudos (RAW) sin tocarlos, viene con Windows y anda
# con cualquier termica ESC/POS. Los drivers modernos de Windows (tipo 4, como
# el "Brother ... Class Driver" que Windows le pone a muchas termicas) NO
# aceptan RAW: pasan todo por un filtro XPS y la termica imprime basura o el
# trabajo falla. Para esas impresoras se crea una cola auxiliar "<nombre>
# (ticket)" con este driver, en el mismo puerto.
$RawDriverName = "Generic / Text Only"
$CompanionSuffix = " (ticket)"

function Test-PhysicalPort([string]$port) {
  return ($port -match '^(USB[0-9]+|LPT[0-9]+|COM[0-9]+|IP_.+|WSD-.+|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+.*|.+\.prn)$')
}

function Get-PrinterList {
  $majors = @{}
  foreach ($d in (Get-PrinterDriver -ErrorAction SilentlyContinue)) { $majors[[string]$d.Name] = [int]$d.MajorVersion }
  $list = @()
  foreach ($p in (Get-CimInstance -ClassName Win32_Printer)) {
    $name = [string]$p.Name
    if ($name.EndsWith($CompanionSuffix)) { continue }
    $driver = [string]$p.DriverName
    $major = 0
    if ($majors.ContainsKey($driver)) { $major = $majors[$driver] }
    $list += @{
      name = $name
      isDefault = [bool]$p.Default
      port = [string]$p.PortName
      driver = $driver
      driverMajor = $major
      isPhysical = (Test-PhysicalPort ([string]$p.PortName))
    }
  }
  return ,$list
}

# Devuelve el nombre de la cola a la que hay que mandar los bytes crudos.
function Get-RawQueueName($p) {
  if ($p.driverMajor -ne 4) { return $p.name }
  $companion = $p.name + $CompanionSuffix
  $existing = Get-Printer -Name $companion -ErrorAction SilentlyContinue
  if (-not $existing) {
    if (-not (Get-PrinterDriver -Name $RawDriverName -ErrorAction SilentlyContinue)) {
      Add-PrinterDriver -Name $RawDriverName
    }
    Add-Printer -Name $companion -DriverName $RawDriverName -PortName $p.port
  } elseif ($existing.PortName -ne $p.port) {
    # El puerto USB cambia de numero si conectan la impresora en otro lugar.
    Set-Printer -Name $companion -PortName $p.port
  }
  return $companion
}

function Handle-Request($ctx) {
  $req = $ctx.Request
  $origin = $req.Headers["Origin"]
  $hostHeader = [string]$req.Headers["Host"]

  # Defensa contra "DNS rebinding": el Host tiene que ser esta PC.
  if ($hostHeader -ne "127.0.0.1:$Port" -and $hostHeader -ne "localhost:$Port") {
    Send-Json $ctx 403 @{ ok = $false; error = "host no permitido" } $null
    return
  }

  if ($req.HttpMethod -eq "OPTIONS") {
    $res = $ctx.Response
    if (Test-AllowedOrigin $origin) {
      $res.StatusCode = 204
      $res.Headers["Access-Control-Allow-Origin"] = $origin
      $res.Headers["Vary"] = "Origin"
      $res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
      $res.Headers["Access-Control-Allow-Headers"] = "content-type"
      $res.Headers["Access-Control-Allow-Private-Network"] = "true"
      $res.Headers["Access-Control-Max-Age"] = "600"
    } else {
      $res.StatusCode = 403
    }
    $res.OutputStream.Close()
    return
  }

  # Sin origen permitido no se responde nada util (ni siquiera /ping).
  if ($origin -and -not (Test-AllowedOrigin $origin)) {
    Send-Json $ctx 403 @{ ok = $false; error = "origen no permitido" } $null
    return
  }

  $path = $req.Url.AbsolutePath

  if ($req.HttpMethod -eq "GET" -and $path -eq "/ping") {
    Send-Json $ctx 200 @{ ok = $true; version = $AgentVersion; computer = $env:COMPUTERNAME } $origin
    return
  }

  if ($req.HttpMethod -eq "GET" -and $path -eq "/printers") {
    Send-Json $ctx 200 @{ ok = $true; printers = (Get-PrinterList) } $origin
    return
  }

  if ($req.HttpMethod -eq "POST" -and $path -eq "/print") {
    # Imprimir exige origen permitido (un pedido sin "Origin" no es de un navegador del sistema).
    if (-not $origin) {
      Send-Json $ctx 403 @{ ok = $false; error = "falta el origen" } $null
      return
    }
    if ($req.ContentLength64 -gt 1048576) {
      Send-Json $ctx 413 @{ ok = $false; error = "el ticket es demasiado grande" } $origin
      return
    }
    $ms = New-Object System.IO.MemoryStream
    $req.InputStream.CopyTo($ms)
    $bytes = $ms.ToArray()
    if ($bytes.Length -eq 0) {
      Send-Json $ctx 400 @{ ok = $false; error = "ticket vacio" } $origin
      return
    }

    $printerName = $req.QueryString["printer"]
    $printers = Get-PrinterList
    $target = $null
    if ([string]::IsNullOrWhiteSpace($printerName)) {
      $target = $printers | Where-Object { $_.isDefault } | Select-Object -First 1
      if (-not $target) {
        Send-Json $ctx 409 @{ ok = $false; error = "Windows no tiene una impresora predeterminada. Elegi una en Configuracion del sistema." } $origin
        return
      }
    } else {
      $target = $printers | Where-Object { $_.name -eq $printerName } | Select-Object -First 1
      if (-not $target) {
        Send-Json $ctx 404 @{ ok = $false; error = "La impresora '$printerName' no esta instalada en esta PC." } $origin
        return
      }
    }
    if (-not $target.isPhysical) {
      Send-Json $ctx 409 @{ ok = $false; error = "'$($target.name)' no es una impresora fisica (es un PDF, fax o similar). Elegi la termica." } $origin
      return
    }

    try {
      $queue = Get-RawQueueName $target
    } catch {
      Send-Json $ctx 500 @{ ok = $false; error = "No se pudo preparar la impresora: $($_.Exception.Message)" } $origin
      return
    }

    $result = [PatagoniaRawPrinter]::Send($queue, $bytes)
    if ($result -eq "OK") {
      Send-Json $ctx 200 @{ ok = $true; printer = $target.name; queue = $queue; bytes = $bytes.Length } $origin
    } else {
      Send-Json $ctx 500 @{ ok = $false; error = $result } $origin
    }
    return
  }

  Send-Json $ctx 404 @{ ok = $false; error = "no existe" } $origin
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try {
  $listener.Start()
} catch {
  # Ya hay otro programa de impresion corriendo en esta PC: no hace falta otro.
  exit 0
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    Handle-Request $ctx
  } catch {
    try { Send-Json $ctx 500 @{ ok = $false; error = "error interno" } $null } catch { }
  }
}
