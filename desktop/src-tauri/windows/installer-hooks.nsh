; Tauri copies a resource directory over an existing installation without
; removing files that disappeared from the new bundle. Hivemind's Core build
; identity deliberately hashes every compiled JavaScript module, so one stale
; module makes the installed Core a different build from the shell that owns
; it. Remove only the replaceable bundled runtime before NSIS writes the new
; one. Project state lives outside $INSTDIR and is not touched.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\core"
  RMDir /r "$INSTDIR\runtime"
!macroend
