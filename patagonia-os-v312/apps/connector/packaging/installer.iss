; Instalador de Patagonia Scale Connect (Inno Setup 6.3 o posterior). SIN FIRMAR todavía.
; El archivo va en UTF-8 CON BOM: sin BOM, Inno Setup lo lee como ANSI y rompe los acentos.
;
; Se compila con scripts/build-installer.mjs (local y CI), que pasa:
;   /DAppVersion=0.1.0  /DSourceDir=<dist\PatagoniaScaleConnect>  /DOutputDir=<dist\installer>
; Antes hay que armar dist\PatagoniaScaleConnect con `npm run package -w @patagonia/connector`.
;
; Qué hace:
;   - Programa en  C:\Program Files\Patagonia\Scale Connect
;   - Datos en     C:\ProgramData\Patagonia\ScaleConnect   (config, diario, bitácoras; NO se pisan)
;   - Registra el servicio con WinSW (inicio automático con retardo, reinicio ante caídas),
;     lo pasa a la cuenta virtual NT SERVICE\PatagoniaScaleConnect (si Windows no la acepta,
;     a NT AUTHORITY\LocalService), le da permisos y lo inicia.
;   - Actualización encima: frena el servicio, reemplaza los archivos y lo vuelve a iniciar.
;   - Al terminar abre http://127.0.0.1:9120/vincular.
;   - Desinstalar saca el servicio y deja los datos, salvo que se elija borrarlos
;     (silencioso: parámetro /BORRARDATOS).
;
; Soporte, sin preguntas:
;   PatagoniaScaleConnect-Setup-X.Y.Z.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="%TEMP%\scale-connect-setup.log"
;   "C:\Program Files\Patagonia\Scale Connect\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES [/BORRARDATOS]
;
; Firma: cuando haya certificado, se firma scale-connect.exe ANTES de compilar esto, y el
; instalador y el desinstalador con SignTool= (ver README, "Qué falta").

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\PatagoniaScaleConnect"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist\installer"
#endif

#define AppName "Patagonia Scale Connect"
#define ServiceId "PatagoniaScaleConnect"
#define VirtualAccount "NT SERVICE\PatagoniaScaleConnect"
#define FallbackAccount "NT AUTHORITY\LocalService"
#define LinkUrl "http://127.0.0.1:9120/vincular"

[Setup]
; AppId fijo: es lo que hace que una versión nueva se instale ENCIMA de la anterior. No cambiarlo nunca.
AppId={{6F3C2B1E-8D47-4A5C-9E21-5B7D0C4A9F13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Patagonia System
AppPublisherURL=https://patagoniasystem.com.ar
AppSupportURL=https://patagoniasystem.com.ar
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
DefaultDirName={autopf}\Patagonia\Scale Connect
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=PatagoniaScaleConnect-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; El servicio lo frena el propio instalador (PrepareToInstall), no el Restart Manager.
CloseApplications=no
RestartApplications=no
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\scale-connect.exe
SetupLogging=yes
SetupMutex=PatagoniaScaleConnectSetup

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[CustomMessages]
es.OpenLinkPage=Abrir la página para vincular esta PC con Patagonia System
es.ServiceFailed=No se pudo registrar o iniciar el servicio Patagonia Scale Connect (paso: %1, código %2).%n%nEl programa quedó copiado. Avisá a soporte de Patagonia System.
es.AskDeleteData=¿Borrar también los datos de Patagonia Scale Connect de esta PC?%n%n(Configuración, vinculación, diario de trabajos y bitácoras, en %1.)%n%nSi vas a reinstalar, elegí No.
es.StoppingService=Frenando el servicio Patagonia Scale Connect...

[Dirs]
; Los datos nunca los borra la desinstalación por sí sola (ver CurUninstallStepChanged).
Name: "{commonappdata}\Patagonia\ScaleConnect"; Flags: uninsneveruninstall
Name: "{commonappdata}\Patagonia\ScaleConnect\logs"; Flags: uninsneveruninstall

[InstallDelete]
; En una actualización, las dependencias viejas no deben quedar mezcladas con las nuevas.
Type: filesandordirs; Name: "{app}\node_modules"

[Files]
Source: "{#SourceDir}\scale-connect.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\PatagoniaScaleConnect.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\PatagoniaScaleConnect.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\build-info.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
; Abre la página de vinculación con el usuario que inició el instalador (no como administrador).
; Si esa página todavía no existe en esta versión del servicio, igual se abre la dirección.
Filename: "{#LinkUrl}"; Description: "{cm:OpenLinkPage}"; Flags: shellexec postinstall nowait skipifsilent runasoriginaluser

[Code]
var
  ServiceAccountUsed: String;

function WinSW: String;
begin
  Result := ExpandConstant('{app}\{#ServiceId}.exe');
end;

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\Patagonia\ScaleConnect');
end;

function Run(const FileName, Params: String; var Code: Integer): Boolean;
begin
  Log(Format('Ejecuta: %s %s', [FileName, Params]));
  Result := Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
  Log(Format('  -> ok=%d código=%d', [Ord(Result), Code]));
end;

function RunOk(const FileName, Params: String): Boolean;
var
  Code: Integer;
begin
  Result := Run(FileName, Params, Code) and (Code = 0);
end;

function Sc(const Params: String; var Code: Integer): Boolean;
begin
  Result := Run(ExpandConstant('{sys}\sc.exe'), Params, Code);
end;

function ServiceExists: Boolean;
var
  Code: Integer;
begin
  // sc query devuelve 1060 si el servicio no existe.
  Result := Sc('query {#ServiceId}', Code) and (Code = 0);
end;

procedure StopService;
var
  Code: Integer;
begin
  // net stop espera a que el servicio quede detenido (2 = ya estaba detenido).
  Run(ExpandConstant('{sys}\net.exe'), 'stop {#ServiceId}', Code);
  // Último recurso: si el proceso quedó colgado, los archivos no se podrían reemplazar.
  Run(ExpandConstant('{sys}\taskkill.exe'), '/F /IM scale-connect.exe', Code);
  Sleep(1000);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if ServiceExists then
  begin
    WizardForm.StatusLabel.Caption := CustomMessage('StoppingService');
    Log('Actualización: hay un servicio instalado, se frena antes de copiar.');
    StopService;
  end;
end;

procedure ServiceError(const Step: String; Code: Integer);
begin
  Log(Format('ERROR del servicio en "%s", código %d', [Step, Code]));
  SuppressibleMsgBox(FmtMessage(CustomMessage('ServiceFailed'), [Step, IntToStr(Code)]), mbError, MB_OK, IDOK);
end;

procedure RegisterAndStartService;
var
  Code: Integer;
begin
  // 1. Alta (primera vez) o refresco de la configuración (actualización). WinSW toma
  //    inicio automático con retardo y las acciones de reinicio del XML.
  if ServiceExists then
  begin
    if not (Run(WinSW, 'refresh', Code) and (Code = 0)) then begin ServiceError('refresh', Code); exit; end;
  end
  else
  begin
    if not (Run(WinSW, 'install', Code) and (Code = 0)) then begin ServiceError('install', Code); exit; end;
  end;

  // 2. Cuenta del servicio. WinSW v3 no puede instalar con una cuenta virtual (ver el XML),
  //    así que se cambia acá. Si Windows no la acepta, se usa LocalService: tampoco es
  //    administrador y también puede abrir los puertos COM.
  ServiceAccountUsed := '{#VirtualAccount}';
  if not (Sc('config {#ServiceId} obj= "{#VirtualAccount}"', Code) and (Code = 0)) then
  begin
    Log('La cuenta virtual no se pudo asignar; se usa LocalService.');
    ServiceAccountUsed := '{#FallbackAccount}';
    if not (Sc('config {#ServiceId} obj= "{#FallbackAccount}" password= ""', Code) and (Code = 0)) then
    begin
      ServiceError('cuenta del servicio', Code);
      exit;
    end;
  end;
  Log('Cuenta del servicio: ' + ServiceAccountUsed);

  // 3. Permisos: escribir en los datos (incluye lo que WinSW ya creó como administrador)
  //    y leer/ejecutar el programa.
  if not RunOk(ExpandConstant('{sys}\icacls.exe'), '"' + DataDir + '" /grant "' + ServiceAccountUsed + ':(OI)(CI)M" /T /C /Q') then
  begin
    ServiceError('permisos de datos', -1);
    exit;
  end;
  RunOk(ExpandConstant('{sys}\icacls.exe'), '"' + ExpandConstant('{app}') + '" /grant "' + ServiceAccountUsed + ':(OI)(CI)RX" /T /C /Q');

  // 4. Inicio. WinSW espera a que el servicio quede corriendo.
  if not (Run(WinSW, 'start', Code) and (Code = 0)) then begin ServiceError('start', Code); exit; end;
  // Un segundo para que el servicio abra 127.0.0.1:9120 antes de abrir la página.
  Sleep(1500);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RegisterAndStartService;
end;

function HasParam(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  DeleteData: Boolean;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Antes de borrar archivos: frenar y dar de baja el servicio.
    if ServiceExists then
    begin
      StopService;
      if not (FileExists(WinSW) and Run(WinSW, 'uninstall', Code) and (Code = 0)) then
        Sc('delete {#ServiceId}', Code);
    end;
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    if UninstallSilent then
      DeleteData := HasParam('/BORRARDATOS')
    else
      DeleteData := MsgBox(FmtMessage(CustomMessage('AskDeleteData'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
    if DeleteData then
    begin
      Log('Se borran los datos: ' + DataDir);
      DelTree(DataDir, True, True, True);
      RemoveDir(ExpandConstant('{commonappdata}\Patagonia'));
    end
    else
      Log('Los datos quedan en ' + DataDir);
  end;
end;
