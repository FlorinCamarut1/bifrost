; Bifrost.exe is the untouched, widely known electron.exe (Windows Smart App Control trusts it by reputation),
; so it keeps Electron's icon: give the shortcuts Bifrost's own icon.
!macro customInstall
  CreateShortCut "$DESKTOP\Bifrost.lnk" "$INSTDIR\Bifrost.exe" "" "$INSTDIR\resources\app.ico" 0
  CreateShortCut "$SMPROGRAMS\Bifrost.lnk" "$INSTDIR\Bifrost.exe" "" "$INSTDIR\resources\app.ico" 0
  WinShell::SetLnkAUMI "$SMPROGRAMS\Bifrost.lnk" "io.github.florincamarut1.bifrost"
  WinShell::SetLnkAUMI "$DESKTOP\Bifrost.lnk" "io.github.florincamarut1.bifrost"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Bifrost.lnk"
  Delete "$SMPROGRAMS\Bifrost.lnk"
!macroend
