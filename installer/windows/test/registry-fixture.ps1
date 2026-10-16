param(
    [Parameter(Mandatory = $true)][string]$Subkey,
    [ValidateSet('Read', 'DeleteOwned')][string]$Mode = 'Read'
)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'DeleteOwned') {
    if ($Subkey -cnotmatch '^Software\\Cudia\\InstallerTests\\[a-f0-9]{32}$') { throw 'Not an owned installer test namespace.' }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($Subkey, $false)
    exit
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32;
public static class InstallerRegistryFixture {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern int RegQueryValueEx(IntPtr key, string name, IntPtr reserved, out uint type, byte[] bytes, ref uint size);
    public static object Read(RegistryKey key, string name) {
        uint type, size=0;
        int error=RegQueryValueEx(key.Handle.DangerousGetHandle(), name, IntPtr.Zero, out type, null, ref size);
        if(error!=0) throw new System.ComponentModel.Win32Exception(error, "Registry query failed: "+error);
        byte[] bytes=new byte[size];
        error=RegQueryValueEx(key.Handle.DangerousGetHandle(), name, IntPtr.Zero, out type, bytes, ref size);
        if(error!=0) throw new System.ComponentModel.Win32Exception(error, "Registry read failed: "+error);
        return new { type=type, data=Convert.ToBase64String(bytes) };
    }
}
'@
for ($taskAttempt = 0; $taskAttempt -lt 8; $taskAttempt++) {
    $taskKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Subkey, $false)
    if ($null -eq $taskKey) { 'null'; exit }
    try {
        $taskValues = [ordered]@{}
        foreach ($taskName in ($taskKey.GetValueNames() | Sort-Object)) {
            $taskValues[$taskName] = [InstallerRegistryFixture]::Read($taskKey, $taskName)
        }
        ConvertTo-Json -InputObject $taskValues -Depth 8 -Compress
        exit
    } catch {
        $taskFailure = $_.Exception.InnerException
        # A value/key can disappear between enumeration and either native read.
        # Reopen the entire snapshot; never equate a query error with absence.
        if ($taskFailure -isnot [System.ComponentModel.Win32Exception] -or
            $taskFailure.NativeErrorCode -notin @(2, 1018) -or $taskAttempt -eq 7) { throw }
    } finally { $taskKey.Dispose() }
    Start-Sleep -Milliseconds 10
}
