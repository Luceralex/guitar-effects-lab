# Create a desktop shortcut for the guitar effects lab
# (UTF-8 BOM required for Chinese filenames under PowerShell 5.1)
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Mentor.lnk'))
$launcher = Join-Path $PSScriptRoot '启动 Mentor.bat'
if (-not (Test-Path -LiteralPath $launcher)) { throw "找不到启动脚本：$launcher" }
$lnk.TargetPath = $launcher
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.IconLocation = (Join-Path $PSScriptRoot 'assets\mentor.ico')
$lnk.Description = 'Mentor 音色与弹奏助手（双击启动后端并打开页面）'
$lnk.Save()
Write-Output ('OK: ' + (Join-Path $desktop 'Mentor.lnk'))
