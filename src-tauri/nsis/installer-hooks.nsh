; Preserve a recovery copy when a legacy system-wide WiX/MSI installation is
; migrated to the current-user NSIS installer. The standard installer checks
; that Atlas is no longer running before this post-install hook executes.
; SQLite's WAL sidecars are included so the backup remains recoverable even if
; SQLite had not checkpointed before the previous process exited.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $WixMode = 1
    ; Preserve every legacy or scoped workspace/user database. New databases
    ; use atlas-{workspaceId}-{userId}.db; atlas-local-mode.db remains a
    ; compatibility read during the migration window.
    ${If} ${FileExists} "$APPDATA\${BUNDLEID}\atlas-*.db"
      CreateDirectory "$APPDATA\${BUNDLEID}\db-backup\msi-nsis-migration-${VERSION}"
      CopyFiles /SILENT "$APPDATA\${BUNDLEID}\atlas-*.db" "$APPDATA\${BUNDLEID}\db-backup\msi-nsis-migration-${VERSION}"

      ${If} ${FileExists} "$APPDATA\${BUNDLEID}\atlas-*.db-wal"
        CopyFiles /SILENT "$APPDATA\${BUNDLEID}\atlas-*.db-wal" "$APPDATA\${BUNDLEID}\db-backup\msi-nsis-migration-${VERSION}"
      ${EndIf}

      ${If} ${FileExists} "$APPDATA\${BUNDLEID}\atlas-*.db-shm"
        CopyFiles /SILENT "$APPDATA\${BUNDLEID}\atlas-*.db-shm" "$APPDATA\${BUNDLEID}\db-backup\msi-nsis-migration-${VERSION}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
