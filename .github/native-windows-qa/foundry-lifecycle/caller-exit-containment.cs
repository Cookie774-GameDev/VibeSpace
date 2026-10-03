using System;
using System.Runtime.InteropServices;
// Disposable CI caller only. No finalizer/Dispose: this exact HANDLE must stay
// alive until the owning PowerShell process exits, invoking KILL_ON_JOB_CLOSE.
public static class S61CallerExitContainment {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long a,b;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic basic;public IO io;public UIntPtr a,b,c,d;}
 [StructLayout(LayoutKind.Sequential)] struct Accounting {public long a,b,c,d;public uint faults,total,active,terminated;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Extended info,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true,EntryPoint="QueryInformationJobObject")] static extern bool QueryAccounting(IntPtr job,int type,out Accounting info,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static IntPtr owner=IntPtr.Zero;static string name;static uint pid;
 public static string Name {get{return name;}}
 public static uint OwnerPID {get{return pid;}}
 public static bool Armed {get{if(owner==IntPtr.Zero)return false;bool member;Extended info;return IsProcessInJob(GetCurrentProcess(),owner,out member)&&member&&QueryInformationJobObject(owner,9,out info,(uint)Marshal.SizeOf(typeof(Extended)),IntPtr.Zero)&&(info.basic.flags&0x2000)!=0&&(info.basic.flags&0x1800)==0;}}
 public static void Arm(string uniqueName){
  if(owner!=IntPtr.Zero)throw new Exception("Earlier caller-exit containment already owned");
  IntPtr handle=CreateJobObject(IntPtr.Zero,uniqueName);if(handle==IntPtr.Zero)throw new Exception("Create caller containment failed "+Marshal.GetLastWin32Error());
  var limits=new Extended();limits.basic.flags=0x2000; // no BREAKAWAY or SILENT_BREAKAWAY
  if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended)))){CloseHandle(handle);throw new Exception("Caller kill-on-close configuration failed");}
  if(!AssignProcessToJobObject(handle,GetCurrentProcess())){CloseHandle(handle);throw new Exception("Cannot contain disposable CI caller; no child permitted");}
  // Once current caller is assigned, NEVER CLOSE this live handle here: that
  // would kill the caller. Retain exact ownership for process lifetime.
  owner=handle;name=uniqueName;pid=GetCurrentProcessId();
  if(!Armed)throw new Exception("Actual caller membership/limits unconfirmed");
 }
 public static uint ActiveProcesses(){if(!Armed)throw new Exception("Caller fallback containment lost");Accounting info;if(!QueryAccounting(owner,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Exception("Caller job accounting unknown");return info.active;}
}