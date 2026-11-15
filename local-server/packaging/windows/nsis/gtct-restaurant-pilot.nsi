; GTCT Restaurant Pilot (TEST) — multi-architecture Windows installer
; Bundled Node runtimes for win-x64 and win-arm64. Selects matching launcher EXE.
; Does NOT enable physical printing or PRODUCTION mode.
; Does NOT touch %LOCALAPPDATA%\GTCT\RestaurantPilot on uninstall/upgrade.

Unicode true
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define PRODUCT_NAME "GTCT Restaurant Pilot"
!define PRODUCT_NAME_FULL "GTCT Restaurant Pilot (TEST)"
!define PRODUCT_PUBLISHER "GTCT"
!define PRODUCT_VERSION "0.1.10"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\GTCTRestaurantPilot.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GTCTRestaurantPilot"

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
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE-PILOT.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\GTCTRestaurantPilot.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch GTCT Restaurant Pilot"
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

  ; Create empty data/backup folders outside the install directory (never the DB).
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantPilot"
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantPilot-Backups"
  ; Reserved production path marker — installer never places the pilot DB here.
  CreateDirectory "$LOCALAPPDATA\GTCT\RestaurantProductionServer"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\GTCT"
  CreateShortCut "$SMPROGRAMS\GTCT\GTCT Restaurant Pilot.lnk" "$INSTDIR\GTCTRestaurantPilot.exe"
  CreateShortCut "$SMPROGRAMS\GTCT\Uninstall GTCT Restaurant Pilot.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\GTCT Restaurant Pilot.lnk" "$INSTDIR\GTCTRestaurantPilot.exe"

  ; Uninstaller / ARP
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\GTCTRestaurantPilot.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME_FULL}"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\GTCTRestaurantPilot.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"

  DetailPrint "Architecture installed: $R9"
  DetailPrint "Persistent database folder: $LOCALAPPDATA\GTCT\RestaurantPilot"
  DetailPrint "Physical printing remains OFF until authorized in the app."
SectionEnd

Section "Uninstall"
  ; Stop running instance if present (best-effort; ignore failures).
  ExecWait 'taskkill /IM GTCTRestaurantPilot.exe /F'
  ClearErrors

  Delete "$DESKTOP\GTCT Restaurant Pilot.lnk"
  Delete "$SMPROGRAMS\GTCT\GTCT Restaurant Pilot.lnk"
  Delete "$SMPROGRAMS\GTCT\Uninstall GTCT Restaurant Pilot.lnk"
  RMDir "$SMPROGRAMS\GTCT"

  ; Remove application files only — NEVER delete RestaurantPilot data/backups.
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"

  MessageBox MB_ICONINFORMATION \
    "GTCT Restaurant Pilot was removed.$\r$\n$\r$\nYour restaurant database and backups were preserved under:$\r$\n$LOCALAPPDATA\GTCT\RestaurantPilot$\r$\n$LOCALAPPDATA\GTCT\RestaurantPilot-Backups"
SectionEnd
