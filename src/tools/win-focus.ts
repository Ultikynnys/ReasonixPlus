/** Shared Windows "find a window by name and raise it" PowerShell fragments for
 *  every focusing tool — a second copy drifts on matching and raise behavior. */

/** user32 P/Invoke surface for window focus + geometry. */
const WIN_FOCUS_P_INVOKE =
  'using System; using System.Runtime.InteropServices; public class WinFocus { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect); }';

/** Add-Type lines defining the `WinFocus` class (idempotent). */
export const PS_WIN_FOCUS_TYPE = [
  `$code = '${WIN_FOCUS_P_INVOKE}';`,
  "Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;",
].join("\n");

/** Resolve a window into `outVar` from `queryExpr`: exact process name (with or
 *  without `.exe`), numeric PID, then substring match on process name and
 *  window title. Throws with the available-window list when nothing matches. */
export function psMatchWindowStatements(queryExpr: string, outVar = "$p"): string[] {
  return [
    "$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -or $_.ProcessName) };",
    `$exact = $procs | Where-Object { $_.ProcessName -ieq ${queryExpr} -or "$($_.ProcessName).exe" -ieq ${queryExpr} } | Select-Object -First 1;`,
    `if ($exact) { ${outVar} = $exact }`,
    `elseif (${queryExpr} -match '^\\d+$') {`,
    `    ${outVar} = $procs | Where-Object { $_.Id -eq [int]${queryExpr} } | Select-Object -First 1;`,
    "}",
    `if (-not ${outVar}) {`,
    `    ${outVar} = $procs | Where-Object { $_.ProcessName -ilike "*${queryExpr}*" } | Select-Object -First 1;`,
    "}",
    `if (-not ${outVar}) {`,
    `    ${outVar} = $procs | Where-Object { $_.MainWindowTitle -ilike "*${queryExpr}*" } | Select-Object -First 1;`,
    "}",
    `if (-not ${outVar}) {`,
    '    $avail = ($procs | Select-Object -First 8 | ForEach-Object { if ($_.MainWindowTitle) { "$($_.ProcessName): $($_.MainWindowTitle)" } else { $_.ProcessName } }) -join "; ";',
    `    throw ("No running application or window matching '" + ${queryExpr} + "' found. Available windows: " + $avail);`,
    "}",
  ];
}

/** Restore-if-minimized, maximize-if-needed, then raise + foreground `outVar`. */
export function psRaiseWindowStatements(outVar = "$p"): string[] {
  return [
    `if ([WinFocus]::IsIconic(${outVar}.MainWindowHandle)) {`,
    `    [WinFocus]::ShowWindow(${outVar}.MainWindowHandle, 9) | Out-Null;`,
    "}",
    // SW_MAXIMIZE only when not already maximized: sending it to an already-maximized
    // window can toggle it back to its normal (windowed) size.
    `if (-not [WinFocus]::IsZoomed(${outVar}.MainWindowHandle)) {`,
    `    [WinFocus]::ShowWindow(${outVar}.MainWindowHandle, 3) | Out-Null;`,
    "}",
    // Raise above every other app without leaving it always-on-top: HWND_TOPMOST then
    // HWND_NOTOPMOST. SetWindowPos works cross-process and bypasses the foreground lock,
    // so the target can never be obscured by whichever window holds the user's focus.
    `[WinFocus]::SetWindowPos(${outVar}.MainWindowHandle, [IntPtr]::new(-1), 0, 0, 0, 0, 3) | Out-Null;`,
    `[WinFocus]::SetWindowPos(${outVar}.MainWindowHandle, [IntPtr]::new(-2), 0, 0, 0, 0, 3) | Out-Null;`,
    `[WinFocus]::BringWindowToTop(${outVar}.MainWindowHandle) | Out-Null;`,
    `[WinFocus]::SetForegroundWindow(${outVar}.MainWindowHandle) | Out-Null;`,
    `[WinFocus]::SwitchToThisWindow(${outVar}.MainWindowHandle, $true);`,
  ];
}
