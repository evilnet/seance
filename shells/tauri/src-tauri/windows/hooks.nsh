; NSIS installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks).

; irc: and ircs: are claimed from Settings, not by the installer (src/lib.rs
; `irc_links`), so the uninstaller's own deep-link cleanup does not know of
; them. Left behind, this user's class would point at a deleted exe and hide
; another client's registration. Removed only while it still opens this app.
!macro SEANCE_RELEASE_SCHEME SCHEME
  ReadRegStr $R7 HKCU "Software\Classes\${SCHEME}\shell\open\command" ""
  ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey HKCU "Software\Classes\${SCHEME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro SEANCE_RELEASE_SCHEME "irc"
  !insertmacro SEANCE_RELEASE_SCHEME "ircs"
!macroend
