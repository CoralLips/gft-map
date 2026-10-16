$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
}
'@
# Only the current synthetic host and its descendants enter this fresh Job.
$job = [OwnedJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero -or -not [OwnedJob]::AssignProcessToJobObject($job, [OwnedJob]::GetCurrentProcess())) { throw 'Cannot create isolated test Job' }
$output = & $env:GFT_TEST_NODE $env:GFT_TEST_CLI start --manual
if ($LASTEXITCODE -ne 0) { throw 'Test service did not start' }
[IO.File]::WriteAllText($env:GFT_TEST_RESULT, ($output -join "`n"))
if (-not [OwnedJob]::TerminateJobObject($job, 91)) { throw 'Cannot terminate owned test Job' }
