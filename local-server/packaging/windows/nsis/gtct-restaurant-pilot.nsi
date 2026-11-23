; GTCT Restaurant Pilot (TEST) — multi-architecture Windows installer
; Bundled Node runtimes for win-x64 and win-arm64. Selects matching launcher EXE.
; Registers always-on Host Scheduled Task (LAN HTTPS) at user logon.
; Does NOT enable PRODUCTION mode.
; Does NOT touch %LOCALAPPDATA%\GTCT\RestaurantPilot on uninstall/upgrade.

Unicode true
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define PRODUCT_NAME "GTCT Restaurant Pilot"
!define PRODUCT_NAME_FULL "GTCT Restaurant Pilot (TEST)"
!define PRODUCT_PUBLISHER "GTCT"
!define PRODUCT_VERSION "0.1.23"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\GTCTRestaurantPilot.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GTCTRestaurantPilot"
!define HOST_TASK_NAME "GTCT Restaurant Host"
!define LAN_TASK_NAME "GTCT Restaurant LAN Prepare"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Name "${PRODUCT_NAME_FULL}"
OutFile "..\dist\GTCT-Restaurant-Pilot-Setup-${PRODUCT_VERSION}.exe"
InstallDir "$PROGRAMFILES64\GTCT\Restaurant Pilot"
InstallDirRegKey HKLM "${PRODUCT_DIR_REGKEY}" ""
ShowInstDetails show
ShowUnInstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "..\icons\gtct-restaurant.ico"
!define MUI_UNICON "..\icons\gtct-restaurant.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE-PILOT.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\GTCTRestaurantPilot.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open GTCT Restaurant in browser"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${If} ${IsNativeARM64}
    StrCpy $R9 "arm64"
  ${ElseIf} ${IsNativeAMD64}
    StrCpy $R9 "x64"
  ${Else}
    MessageBox MB_ICONSTOP "GTCT Restaurant Pilot requires 64-bit Windows (x64 or ARM64)."
    Abort
  ${EndIf}
FunctionEnd

Section "Install" SecInstall
  SetOutPath "$INSTDIR"

  ; Stop a running host/app before overwriting native modules (better-sqlite3 .node).
  ; The always-on host keeps node.exe + win32-*.node locked during upgrade.
  DetailPrint "Stopping any running GTCT Restaurant Pilot host..."
  nsExec::ExecToLog 'schtasks /End /TN "${HOST_TASK_NAME}"'
  nsExec::ExecToLog 'taskkill /IM GTCTRestaurantPilot.exe /F'
  nsExec::ExecToLog 'taskkill /IM node.exe /F'
  Sleep 1500

  ; Shared application payload (JS/UI) + both Node runtimes for offline use.
  File /r "..\dist\payload\app"
  File /r "..\dist\payload\runtime"
  File "..\dist\payload\APP-INFO.txt"

  ; Architecture-correct windowed launcher (no BAT / no Terminal required).
  ${If} $R9 == "arm64"
    File /oname=GTCTRestaurantPilot.exe "..\dist\payload\GTCTRestaurantPilot-arm64.exe"
  ${Else}
    File /oname=GTCTRestaurantPilot.exe "..\dist\payload\GTCTRestaurantPilot-x64.exe"
  ${EndIf}

  ; App icon (shortcuts / Add/Remove Programs fallback)
  File /oname=gtct-restaurant.ico "..\icons\gtct-restaurant.ico"
  ; Optional ops TLS helper (host normally generates certs itself)
  File /oname=ensure-lan-cert.ps1 "..\scripts\ensure-lan-cert.ps1"
  File /oname=trust-lan-cert.ps1 "..\scripts\trust-lan-cert.ps1"
  File /oname=Trust-LAN-Certificate.cmd "..\scripts\Trust-LAN-Certificate.cmd"
  File /oname=prepare-lan-access.ps1 "..\scripts\prepare-lan-access.ps1"
  File /oname=Prepare-LAN-Access.cmd "..\scripts\Prepare-LAN-Access.cmd"
  File /oname=Reset-Staff-Password.cmd "..\scripts\Reset-Staff-Password.cmd"

  ; Create empty data/backup folders outside the install directory (never the DB).
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantPilot"
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantPilot-Backups"
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantPilot\tls"
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantPilot\logs"
  ; Reserved production path marker — installer never places the pilot DB here.
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantProductionServer"

  ; Shortcuts — browser/app mode (no --host). Host starts via Scheduled Task.
  CreateDirectory "$SMPROGRAMS\GTCT"
  CreateShortCut "$SMPROGRAMS\GTCT\Open GTCT Restaurant.lnk" "$INSTDIR\GTCTRestaurantPilot.exe" "" "$INSTDIR\gtct-restaurant.ico" 0
  CreateShortCut "$SMPROGRAMS\GTCT\Reset Staff Password.lnk" "$INSTDIR\Reset-Staff-Password.cmd" "" "$INSTDIR\gtct-restaurant.ico" 0
  CreateShortCut "$SMPROGRAMS\GTCT\Trust LAN Certificate.lnk" "$INSTDIR\Trust-LAN-Certificate.cmd" "" "$INSTDIR\gtct-restaurant.ico" 0
  CreateShortCut "$SMPROGRAMS\GTCT\Prepare LAN Access.lnk" "$INSTDIR\Prepare-LAN-Access.cmd" "" "$INSTDIR\gtct-restaurant.ico" 0
  CreateShortCut "$SMPROGRAMS\GTCT\Uninstall GTCT Restaurant Pilot.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\gtct-restaurant.ico" 0
  CreateShortCut "$DESKTOP\GTCT Restaurant Pilot.lnk" "$INSTDIR\GTCTRestaurantPilot.exe" "" "$INSTDIR\gtct-restaurant.ico" 0

  ; Plug & play LAN: firewall rules + GPO fallback (may turn Firewall OFF for TEST).
  DetailPrint "Preparing LAN access for phones/tablets (no manual CMD)..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\prepare-lan-access.ps1" -InstallDir "$INSTDIR" -Port 8787'

  ; Permanent LAN: re-apply prepare at every boot as SYSTEM (survives reboot + firewall turned back on).
  DetailPrint "Registering Scheduled Task: ${LAN_TASK_NAME}"
  nsExec::ExecToLog 'schtasks /Delete /TN "${LAN_TASK_NAME}" /F'
  nsExec::ExecToLog 'schtasks /Create /F /TN "${LAN_TASK_NAME}" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$INSTDIR\prepare-lan-access.ps1\" -InstallDir \"$INSTDIR\" -Port 8787"'

  ; Always-on host at user logon (LAN HTTPS when private IP + cert ready).
  DetailPrint "Registering Scheduled Task: ${HOST_TASK_NAME}"
  nsExec::ExecToLog 'schtasks /Delete /TN "${HOST_TASK_NAME}" /F'
  nsExec::ExecToLog 'schtasks /Create /F /TN "${HOST_TASK_NAME}" /SC ONLOGON /RL LIMITED /TR "\"$INSTDIR\GTCTRestaurantPilot.exe\" --host"'
  ; Start host now so other devices can connect without reboot
  DetailPrint "Starting always-on host..."
  Exec '"$INSTDIR\GTCTRestaurantPilot.exe" --host'

  ; Uninstaller / ARP
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\GTCTRestaurantPilot.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME_FULL}"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\gtct-restaurant.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"

  DetailPrint "Architecture installed: $R9"
  DetailPrint "Host starts at Windows logon (Scheduled Task)."
  DetailPrint "Tablets: https://<this-pc-lan-ip>:8787/pair.html"
  DetailPrint "Persistent database folder: $LOCALAPPDATA\GTCT\RestaurantPilot"
  DetailPrint "If phone cannot connect later: Start Menu → GTCT → Prepare LAN Access"
SectionEnd

Section "Uninstall"
  ; Stop host / app (best-effort).
  nsExec::ExecToLog 'schtasks /End /TN "${HOST_TASK_NAME}"'
  nsExec::ExecToLog 'schtasks /Delete /TN "${HOST_TASK_NAME}" /F'
  nsExec::ExecToLog 'schtasks /End /TN "${LAN_TASK_NAME}"'
  nsExec::ExecToLog 'schtasks /Delete /TN "${LAN_TASK_NAME}" /F'
  ExecWait 'taskkill /IM GTCTRestaurantPilot.exe /F'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="GTCT Restaurant Pilot HTTPS"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="GTCT Restaurant Pilot Node x64"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="GTCT Restaurant Pilot Node ARM64"'
  ClearErrors

  Delete "$DESKTOP\GTCT Restaurant Pilot.lnk"
  Delete "$SMPROGRAMS\GTCT\Open GTCT Restaurant.lnk"
  Delete "$SMPROGRAMS\GTCT\GTCT Restaurant Pilot.lnk"
  Delete "$SMPROGRAMS\GTCT\Reset Staff Password.lnk"
  Delete "$SMPROGRAMS\GTCT\Trust LAN Certificate.lnk"
  Delete "$SMPROGRAMS\GTCT\Prepare LAN Access.lnk"
  Delete "$SMPROGRAMS\GTCT\Uninstall GTCT Restaurant Pilot.lnk"
  RMDir "$SMPROGRAMS\GTCT"

  ; Remove application files only — NEVER delete RestaurantPilot data/backups.
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"

  MessageBox MB_ICONINFORMATION \
    "GTCT Restaurant Pilot was removed.$\r$\n$\r$\nYour restaurant database and backups were preserved under:$\r$\n$LOCALAPPDATA\GTCT\RestaurantPilot$\r$\n$LOCALAPPDATA\GTCT\RestaurantPilot-Backups"
SectionEnd
