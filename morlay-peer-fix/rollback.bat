@echo off
REM Rollback: restore the 4 @morlay package.json files from snapshot (kept, repeat-safe).
setlocal
set "PROFILE_DIR=%USERPROFILE%\.dsh\profiles\web"
set "SNAP_DIR=%PROFILE_DIR%\.morlay-peer-fix-snapshot"
if not exist "%SNAP_DIR%" (
  echo NOTHING TO ROLLBACK: no snapshot at %SNAP_DIR%.
  exit /b 0
)
for %%p in (better-session session-branch session-rdb ui-conversation-message-actions) do (
  if exist "%SNAP_DIR%\@morlay\%%p.package.json" (
    copy /y "%SNAP_DIR%\@morlay\%%p.package.json" "%PROFILE_DIR%\node_modules\@morlay\%%p\package.json" >nul
    echo RESTORED: @morlay/%%p/package.json
  ) else (
    echo SKIP: no snapshot entry for %%p
  )
)
echo DONE: rollback complete (snapshot kept).
