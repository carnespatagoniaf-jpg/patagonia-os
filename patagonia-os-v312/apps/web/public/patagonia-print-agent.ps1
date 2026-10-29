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
$AgentVersion = 4

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

# Fisica = todo lo que no sea una impresora virtual (PDF, XPS, OneNote, fax, archivo). Antes era al reves (solo
# USB001/COM1/...) y las termicas cuyo driver usa otro puerto (TMUSB001, ESDPRT001, RW001...) no aparecian en la
# lista (real M2 Alimentos, 24/10/2026).
function Test-PhysicalPort([string]$port, [string]$driver = '', [string]$name = '') {
  if ($port -match '^(PORTPROMPT:|nul:?|FILE:|SHRFAX:|XPSPort:|Ne[0-9]+:|PDF.*|OneNote.*|Microsoft.*)$') { return $false }
  if (($driver + ' ' + $name) -match '(PDF|XPS|OneNote|Fax|Microsoft Print|AnyDesk|TeamViewer|Remote|Redirect)') { return $false }
  return $true
}

# Puertos USB00x con una impresora USB enchufada AHORA (interfaz USBPRINT con Control\Linked = 1), o $null si no se
# pudo leer. Se lee del registro sin ser administrador.
function Get-PresentUsbPrinterPorts {
  try {
    $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'
    if (-not (Test-Path $root)) { return $null }
    $ports = @{}
    foreach ($k in (Get-ChildItem $root -ErrorAction Stop)) {
      $params = Get-ItemProperty -Path (Join-Path $k.PSPath '#\Device Parameters') -ErrorAction SilentlyContinue
      $control = Get-ItemProperty -Path (Join-Path $k.PSPath '#\Control') -ErrorAction SilentlyContinue
      if ($params -and $control -and [int]$control.Linked -eq 1 -and $params.'Port Number' -ne $null) {
        $base = [string]$params.'Base Name'
        if (-not $base) { $base = 'USB' }
        $ports[$base + ([int]$params.'Port Number').ToString('000')] = $true
      }
    }
    return $ports
  } catch {
    return $null
  }
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
      isPhysical = (Test-PhysicalPort ([string]$p.PortName) $driver $name)
    }
  }
  # Termica enchufada pero sin impresora en Windows (no se instalo el driver): Windows igual crea el puerto
  # USB001, USB002... Se ofrece ese puerto libre como "Impresora USB (USB001)"; al imprimir, Get-RawQueueName le
  # crea la cola con el driver generico de texto (real M2 Alimentos, 24/10/2026: Windows solo tenia OneNote/PDF).
  $used = @{}
  foreach ($p in (Get-CimInstance -ClassName Win32_Printer)) {
    if (-not ([string]$p.Name).EndsWith($CompanionSuffix)) { $used[[string]$p.PortName] = $true }
  }
  $present = Get-PresentUsbPrinterPorts
  $known = ($present -ne $null) -and ($present.Count -gt 0)
  $hasReal = @($list | Where-Object { $_.isPhysical }).Count -gt 0
  # En una PC que ya tiene su impresora instalada no se agrega nada, salvo un puerto con algo enchufado ahora.
  if ($hasReal -and -not $known) { return ,$list }
  foreach ($port in (Get-PrinterPort -ErrorAction SilentlyContinue)) {
    $portName = [string]$port.Name
    # Windows deja puertos USB00x viejos de aparatos que ya no estan: se ofrece solo el que tiene algo enchufado
    # (si no se pudo saber, todos los libres).
    $isPresent = (-not $known) -or $present.ContainsKey($portName)
    if ($portName -match '^USB[0-9]+$' -and -not $used.ContainsKey($portName) -and $isPresent) {
      $list += @{
        name = "Impresora USB enchufada ($portName)"
        isDefault = $false
        port = $portName
        driver = ""
        driverMajor = 4
        isPhysical = $true
      }
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

# ---------------------------------------------------------------------------
# Balanza por cable de red (Kretz Report con Ethernet, desde la version 4).
# Chrome no puede abrir una conexion TCP: este programa la abre y le pasa los
# bytes tal cual (el sistema arma y revisa cada trama, igual que por USB o
# Bluetooth). Una sola conexion a la vez. Solo direcciones de la red local
# (10.x, 172.16-31.x, 192.168.x, 169.254.x): nunca hacia internet.
# ---------------------------------------------------------------------------
$script:ScaleClient = $null
$script:ScaleStream = $null
$script:ScaleTarget = ""

function Test-LocalScaleHost([string]$h) {
  $ip = $null
  if (-not [System.Net.IPAddress]::TryParse($h, [ref]$ip)) { return $false }
  if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $b = $ip.GetAddressBytes()
  if ($b[0] -eq 10) { return $true }
  if ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) { return $true }
  if ($b[0] -eq 192 -and $b[1] -eq 168) { return $true }
  if ($b[0] -eq 169 -and $b[1] -eq 254) { return $true }
  return $false
}

function Close-ScaleLink {
  try { if ($script:ScaleStream) { $script:ScaleStream.Close() } } catch { }
  try { if ($script:ScaleClient) { $script:ScaleClient.Close() } } catch { }
  $script:ScaleClient = $null
  $script:ScaleStream = $null
  $script:ScaleTarget = ""
}

# Las direcciones IPv4 de esta PC (para saber si la balanza esta en la misma red).
function Get-LocalIPv4 {
  $out = @()
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
    if ($nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
    foreach ($u in $nic.GetIPProperties().UnicastAddresses) {
      if ($u.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
      $out += @{ name = [string]$nic.Name; kind = [string]$nic.NetworkInterfaceType; ip = $u.Address.ToString(); mask = [string]$u.IPv4Mask }
    }
  }
  return ,$out
}

function Open-ScaleLink([string]$h, [int]$p) {
  Close-ScaleLink
  $c = New-Object System.Net.Sockets.TcpClient
  $ar = $c.BeginConnect($h, $p, $null, $null)
  if (-not $ar.AsyncWaitHandle.WaitOne(3000)) {
    try { $c.Close() } catch { }
    return "La balanza no contesta en $h (puerto $p)."
  }
  try {
    $c.EndConnect($ar)
  } catch {
    try { $c.Close() } catch { }
    return "La balanza rechazo la conexion en $h (puerto $p)."
  }
  $c.NoDelay = $true
  $script:ScaleClient = $c
  $script:ScaleStream = $c.GetStream()
  $script:ScaleTarget = "${h}:$p"
  return "OK"
}

# Lo que mando la balanza: espera hasta $ms el primer byte y despues junta lo
# que siga llegando hasta 60 ms de silencio. closed = la balanza corto.
function Read-ScaleLink([int]$ms) {
  $buf = New-Object System.IO.MemoryStream
  $tmp = New-Object byte[] 4096
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  $lastData = $null
  $closed = $false
  while ($true) {
    $now = [DateTime]::UtcNow
    if ($script:ScaleStream.DataAvailable) {
      $n = $script:ScaleStream.Read($tmp, 0, $tmp.Length)
      if ($n -le 0) { $closed = $true; break }
      $buf.Write($tmp, 0, $n)
      $lastData = $now
      continue
    }
    $sock = $script:ScaleClient.Client
    if ($sock.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $sock.Available -eq 0) { $closed = $true; break }
    if ($lastData -ne $null -and ($now - $lastData).TotalMilliseconds -ge 60) { break }
    if ($lastData -eq $null -and $now -ge $deadline) { break }
    Start-Sleep -Milliseconds 5
  }
  return @{ data = [Convert]::ToBase64String($buf.ToArray()); closed = $closed }
}

# Busca balanzas en la red de cada placa de esta PC (las 254 direcciones de su
# /24, en paralelo): las que aceptan conexion en ese puerto.
function Find-ScaleHosts([int]$p) {
  $found = @()
  $tries = @()
  foreach ($a in (Get-LocalIPv4)) {
    if (-not (Test-LocalScaleHost $a.ip)) { continue }
    $parts = $a.ip.Split('.')
    $prefix = $parts[0] + '.' + $parts[1] + '.' + $parts[2] + '.'
    for ($i = 1; $i -le 254; $i++) {
      $target = $prefix + $i
      $c = New-Object System.Net.Sockets.TcpClient
      $tries += @{ ip = $target; client = $c; ar = $c.BeginConnect($target, $p, $null, $null) }
    }
  }
  $until = [DateTime]::UtcNow.AddMilliseconds(1500)
  while ([DateTime]::UtcNow -lt $until) {
    if (@($tries | Where-Object { -not $_.ar.IsCompleted }).Count -eq 0) { break }
    Start-Sleep -Milliseconds 50
  }
  foreach ($t in $tries) {
    try {
      if ($t.ar.IsCompleted) {
        $t.client.EndConnect($t.ar)
        if ($t.client.Connected) { $found += $t.ip }
      }
    } catch { }
    try { $t.client.Close() } catch { }
  }
  return ,$found
}

function Handle-ScaleRequest($ctx, [string]$path, [string]$origin) {
  $req = $ctx.Request
  if (-not $origin) {
    Send-Json $ctx 403 @{ ok = $false; error = "falta el origen" } $null
    return
  }
  if ($path -eq "/scale/find") {
    $p = 0
    if (-not [int]::TryParse([string]$req.QueryString["port"], [ref]$p) -or $p -lt 1 -or $p -gt 65535) { $p = 1001 }
    Send-Json $ctx 200 @{ ok = $true; port = $p; found = (Find-ScaleHosts $p); local = (Get-LocalIPv4) } $origin
    return
  }
  if ($req.HttpMethod -ne "POST") {
    Send-Json $ctx 405 @{ ok = $false; error = "metodo no permitido" } $origin
    return
  }
  if ($path -eq "/scale/open") {
    $h = [string]$req.QueryString["host"]
    $p = 0
    if (-not (Test-LocalScaleHost $h)) {
      Send-Json $ctx 400 @{ ok = $false; error = "La direccion '$h' no es de la red local."; local = (Get-LocalIPv4) } $origin
      return
    }
    if (-not [int]::TryParse([string]$req.QueryString["port"], [ref]$p) -or $p -lt 1 -or $p -gt 65535) {
      Send-Json $ctx 400 @{ ok = $false; error = "Puerto invalido." } $origin
      return
    }
    $r = Open-ScaleLink $h $p
    if ($r -eq "OK") { Send-Json $ctx 200 @{ ok = $true; target = $script:ScaleTarget } $origin }
    else { Send-Json $ctx 502 @{ ok = $false; error = $r; local = (Get-LocalIPv4) } $origin }
    return
  }
  if ($path -eq "/scale/close") {
    Close-ScaleLink
    Send-Json $ctx 200 @{ ok = $true } $origin
    return
  }
  if (-not $script:ScaleStream) {
    Send-Json $ctx 409 @{ ok = $false; error = "La conexion con la balanza no esta abierta."; closed = $true } $origin
    return
  }
  if ($path -eq "/scale/write") {
    if ($req.ContentLength64 -gt 65536) {
      Send-Json $ctx 413 @{ ok = $false; error = "demasiado grande" } $origin
      return
    }
    $ms = New-Object System.IO.MemoryStream
    $req.InputStream.CopyTo($ms)
    $bytes = $ms.ToArray()
    try {
      $script:ScaleStream.Write($bytes, 0, $bytes.Length)
      $script:ScaleStream.Flush()
      Send-Json $ctx 200 @{ ok = $true; bytes = $bytes.Length } $origin
    } catch {
      Close-ScaleLink
      Send-Json $ctx 502 @{ ok = $false; error = "Se corto la conexion con la balanza."; closed = $true } $origin
    }
    return
  }
  if ($path -eq "/scale/read") {
    $wait = 0
    if (-not [int]::TryParse([string]$req.QueryString["ms"], [ref]$wait) -or $wait -lt 0) { $wait = 300 }
    if ($wait -gt 3000) { $wait = 3000 }
    try {
      $r = Read-ScaleLink $wait
      if ($r.closed) { Close-ScaleLink }
      Send-Json $ctx 200 @{ ok = $true; data = $r.data; closed = $r.closed } $origin
    } catch {
      Close-ScaleLink
      Send-Json $ctx 502 @{ ok = $false; error = "Se corto la conexion con la balanza."; closed = $true } $origin
    }
    return
  }
  Send-Json $ctx 404 @{ ok = $false; error = "no existe" } $origin
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

  if ($path.StartsWith("/scale/")) {
    Handle-ScaleRequest $ctx $path $origin
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

# La primera consulta de impresoras carga varios modulos de Windows y puede
# tardar unos segundos (mas en una PC lenta): se hace ahora, apenas arranca,
# para que nadie la espere despues, cuando esta cobrando o eligiendo impresora.
try { Get-PrinterList | Out-Null } catch { }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    Handle-Request $ctx
  } catch {
    try { Send-Json $ctx 500 @{ ok = $false; error = "error interno" } $null } catch { }
  }
}
