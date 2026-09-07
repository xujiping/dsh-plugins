@echo off
REM Fix: widen @morlay/* peerDependencies ^0.1.1-rc.2 -> ^0.1.0-rc.6.
REM Idempotent: creates snapshot ONLY if none exists.
setlocal enabledelayedexpansion
set "PROFILE_DIR=%USERPROFILE%\.dsh\profiles\web"
set "SNAP_DIR=%PROFILE_DIR%\.morlay-peer-fix-snapshot"
if not exist "%PROFILE_DIR%" echo ERROR: profile dir not found & exit /b 1
if exist "%SNAP_DIR%" (
  echo SKIP: snapshot already exists at %SNAP_DIR%. Rollback first or remove it deliberately.
  exit /b 0
)
mkdir "%SNAP_DIR%\@morlay" 2>nul
for %%p in (better-session session-branch session-rdb ui-conversation-message-actions) do (
  if not exist "%PROFILE_DIR%\node_modules\@morlay\%%p\package.json" (
    echo ERROR: missing %%p package.json — aborting before any modification.
    exit /b 1
  )
  copy /y "%PROFILE_DIR%\node_modules\@morlay\%%p\package.json" "%SNAP_DIR%\@morlay\%%p.package.json" >nul
)
echo OK: snapshot created at %SNAP_DIR%
for %%p in (better-session session-branch session-rdb ui-conversation-message-actions) do (
  powershell -NoProfile -Command "(Get-Content -Raw '%PROFILE_DIR%\node_modules\@morlay\%%p\package.json') -replace [regex]::Escape('\"^0.1.1-rc.2\"'),'\"^0.1.0-rc.6\"' | Set-Content -NoNewline '%PROFILE_DIR%\node_modules\@morlay\%%p\package.json'"
  echo PATCHED: @morlay/%%p/package.json
)
echo DONE. Restart dsh web to re-run checks.
