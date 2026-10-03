param([Parameter(Mandatory)][string]$RootSupervisionJSON,[Parameter(Mandatory)][string]$RootSupervisionSHA256)
$ErrorActionPreference='Stop'
if((Get-FileHash -LiteralPath $RootSupervisionJSON -Algorithm SHA256).Hash.ToLowerInvariant() -ne $RootSupervisionSHA256){throw 'Supervisor authority SHA mismatch'}
$s=Get-Content -LiteralPath $RootSupervisionJSON -Raw|ConvertFrom-Json
$now=[DateTimeOffset]::UtcNow
if($s.authority -ne 'ROOT' -or $s.purpose -ne 'S61A4_FOUNDRY_REAL_LIFECYCLE' -or $s.watchdogArmed -ne $true -or $s.killOnClose -ne $true -or $s.processTreeScope -ne 'THIS_RUNNER_AND_ALL_DESCENDANTS' -or !$s.watchdogDriverSHA256 -or !$s.jobName -or $s.maximumSeconds -gt 5400 -or $s.maximumSeconds -lt 1 -or $now -ge [DateTimeOffset]::Parse($s.expiresAtUtc)){throw 'Bounded active ROOT process-tree supervisor required'}
$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$s.supervisorPID)
if(!$process -or ([DateTimeOffset]$process.CreationDate.ToUniversalTime()).ToString('o') -ne $s.supervisorBirthUtc){throw 'Exact watchdog PID/birth absent or reused'}
if((Get-FileHash -LiteralPath $process.ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $s.supervisorExecutableSHA256){throw 'Watchdog executable identity mismatch'}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class S61ExistingJobProof {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long a,b;public uint flags; public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic basic;public IO io;public UIntPtr a,b,c,d;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Extended info,uint size,IntPtr length);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static bool Verify(string jobName,int supervisorPID) {
  IntPtr job=OpenJobObject(4,false,jobName), supervisor=IntPtr.Zero;
  if(job==IntPtr.Zero) return false;
  try {bool member;Extended limits;
   if(!IsProcessInJob(GetCurrentProcess(),job,out member)||!member) return false;
   if(!QueryInformationJobObject(job,9,out limits,(uint)Marshal.SizeOf(typeof(Extended)),IntPtr.Zero)||(limits.basic.flags&0x2000)==0) return false;
   supervisor=OpenProcess(0x0400,false,supervisorPID);if(supervisor==IntPtr.Zero) return false;
   // External watchdog must survive termination of the protected compile/test tree.
   return IsProcessInJob(supervisor,job,out member)&&!member;
  } finally {if(supervisor!=IntPtr.Zero)CloseHandle(supervisor);CloseHandle(job);}
 }
}
"@
if(![S61ExistingJobProof]::Verify($s.jobName,[int]$s.supervisorPID)){throw 'Actual named job membership/KILL_ON_CLOSE/external watchdog proof failed'}
# Actual deadline callback belongs to ROOT's driver; its armed receipt is mandatory,
# not manufactured here. This read-only verifier does not itself launch/terminate.
$s