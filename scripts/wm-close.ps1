# Sends WM_CLOSE to the visible ClipForge window (same as clicking the X button).
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }
"@
$h = [IntPtr](Get-Process electron | ? { $_.MainWindowTitle -eq "ClipForge" } | select -First 1).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { "no window"; exit 1 }
[W]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 800
"visible after WM_CLOSE: " + [W]::IsWindowVisible($h)
