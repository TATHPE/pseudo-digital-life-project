# 截屏（2026-11-12，眼的 Windows 侧）。由 src/vision.ts 的 capture() 以 -File 调起。
# 多屏合并取 VirtualScreen；存 PNG；往 stdout 打一句 "宽x高" 供调用方读尺寸。
param([Parameter(Mandatory = $true)][string]$OutPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("{0}x{1}" -f $vs.Width, $vs.Height)