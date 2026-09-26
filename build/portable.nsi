; JavShelf portable launcher.
;
; electron-builder's own portable target unpacks into $TEMP, so the settings file ends up
; somewhere nobody can find (and Windows is free to delete it). This unpacks next to the
; launcher instead, reuses that folder while the version marker matches, and points the
; app's userData at the launcher's own directory so config.json sits beside the exe.
;
; Compiled by tools/build-portable.js with -DAPPVER -DUNPACKED -DOUTFILE -DICON.
; Keep this file ASCII-only: NSIS reads scripts in the active code page, and a stray
; multi-byte comment makes it abort with "Bad text encoding".

!include "LogicLib.nsh"

Name "JavShelf"
Caption "JavShelf Portable"
OutFile "${OUTFILE}"
Icon "${ICON}"
SetCompressor /SOLID lzma
SetCompressorDictSize 64
XPStyle on
RequestExecutionLevel user
ShowInstDetails nevershow

!define APPDIR "JavShelf-app"
!define MARKER "javshelf-unpacked.version"

Section
  StrCpy $INSTDIR "$EXEDIR\${APPDIR}"

  IfFileExists "$INSTDIR\${MARKER}" 0 extract
  ClearErrors
  FileOpen $1 "$INSTDIR\${MARKER}" r
  IfErrors extract 0
  FileRead $1 $2
  FileClose $1
  StrCmp $2 "${APPVER}" launch 0

  extract:
    DetailPrint "Unpacking JavShelf to $INSTDIR"
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"
    SetOutPath "$INSTDIR"
    File /r "${UNPACKED}\*.*"
    FileOpen $1 "$INSTDIR\${MARKER}" w
    FileWrite $1 "${APPVER}$\r$\n"
    FileClose $1

  launch:
    ; The app reads this to keep config.json next to the launcher, not in %APPDATA%.
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR") i .r0'
    ExecWait '"$INSTDIR\JavShelf.exe"' $0
SectionEnd
