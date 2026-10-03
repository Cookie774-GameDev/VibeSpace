using System;
using System.Text;
using System.Runtime.InteropServices;
public sealed class S61LifecycleJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long a,b;public uint flags; public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic basic;public IO io;public UIntPtr a,b,c,d;}
 [StructLayout(LayoutKind.Sequential)] struct Accounting {public long a,b,c,d;public uint faults,total,active,terminated;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public uint size;public string reserved,desktop,title;public uint x,y,xsize,ysize,xchars,ychars,fill,flags;public ushort show,reserved2;public IntPtr reservedPtr,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr procAttr,IntPtr threadAttr,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero;
 public static S61LifecycleJob RetainedOwner; public bool Assigned { get { return assigned; } }
 bool assigned=false;public uint ChildPID{get;private set;}
 static Exception Error(string text){return new Exception(text+" Win32="+Marshal.GetLastWin32Error());}
 public S61LifecycleJob(string name){
  job=CreateJobObject(IntPtr.Zero,name);if(job==IntPtr.Zero)throw Error("Create owned job failed");
  var limits=new Extended();limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
  if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended)))){CloseHandle(job);job=IntPtr.Zero;throw Error("Set kill-on-close failed");}
 }
 public void SpawnSuspended(string executable,string commandLine,string cwd){
  var start=new Startup();start.size=(uint)Marshal.SizeOf(typeof(Startup));ProcessInfo pi;
  if(!CreateProcess(executable,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref start,out pi))throw Error("Create suspended runner failed");
  process=pi.process;thread=pi.thread;ChildPID=pi.pid;
  if(!AssignProcessToJobObject(job,process)){
   var error=Error("Assign suspended runner failed");
   // Exact HANDLE cleanup also covers the child not yet assigned to this job.
   bool terminated=TerminateProcess(process,1);uint wait=WaitForSingleObject(process,5000);
   if(!terminated||wait!=0)throw new Exception(error.Message+"; unassigned exact child cleanup unconfirmed");
   throw error;
  }
  assigned=true;
 }
 public void Resume(){if(!assigned||thread==IntPtr.Zero)throw new Exception("Runner not contained");if(ResumeThread(thread)!=1)throw Error("Runner did not resume exactly once");CloseHandle(thread);thread=IntPtr.Zero;}
 public bool RootExited(){if(process==IntPtr.Zero)return true;uint wait=WaitForSingleObject(process,0);if(wait==0)return true;if(wait==258)return false;throw Error("Owned root wait failed");}
 public uint ExitCode(){uint code;if(process==IntPtr.Zero||!GetExitCodeProcess(process,out code))throw Error("Owned root exit query failed");return code;}
 public uint Active(){Accounting info;if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw Error("Owned job empty query failed");return info.active;}
 public void Terminate(){if(job!=IntPtr.Zero&&!TerminateJobObject(job,1))throw Error("Owned job termination failed");if(process!=IntPtr.Zero&&!assigned&&!RootExited()&&!TerminateProcess(process,1))throw Error("Unassigned owned root termination failed");}
 public bool ConfirmClosed(){return RootExited()&&Active()==0;}
 public void Dispose(){
  // Kill-on-close is fallback containment, never silently turn it into closure PASS.
  if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}
  if(thread!=IntPtr.Zero){CloseHandle(thread);thread=IntPtr.Zero;}
  if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}
 }
 public static string Quote(string arg){
  var b=new StringBuilder("\"");int slashes=0;
  foreach(char c in arg){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}
  b.Append('\\',slashes*2);b.Append('"');return b.ToString();
 }
}