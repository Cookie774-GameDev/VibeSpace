# Remote-only admission. No desktop switches, logon, RDP or local app access.
function Get-RemoteDesktopAdmission {
 if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true'){throw 'consumer_remote_desktop_probe_only'}
 if(-not ('Q18DesktopProbe' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Q18DesktopProbe {
 [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
 [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll", EntryPoint="GetUserObjectInformationW", SetLastError=true)] static extern bool Info(IntPtr obj, int index, IntPtr data, uint size, out uint needed);
 [DllImport("wtsapi32.dll", EntryPoint="WTSQuerySessionInformationW", SetLastError=true)] static extern bool SessionInfo(IntPtr server, uint session, int type, out IntPtr data, out uint bytes);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
 static string Name(IntPtr handle) {
  IntPtr data=Marshal.AllocHGlobal(512);
  try { uint needed; return Info(handle,2,data,512,out needed) ? Marshal.PtrToStringUni(data) : null; }
  finally { Marshal.FreeHGlobal(data); }
 }
 static int Value(IntPtr handle,int index,int offset,int size) {
  IntPtr data=Marshal.AllocHGlobal(size);
  try { uint needed; return Info(handle,index,data,(uint)size,out needed) ? Marshal.ReadInt32(data,offset) : -1; }
  finally { Marshal.FreeHGlobal(data); }
 }
 public static object[] Probe() {
  uint sid=(uint)Process.GetCurrentProcess().SessionId;
  int state=-1; IntPtr data=IntPtr.Zero; uint bytes;
  if(SessionInfo(IntPtr.Zero,sid,8,out data,out bytes)) {
   try {if(bytes>=4) state=Marshal.ReadInt32(data);} finally {WTSFreeMemory(data);}
  }
  IntPtr station=GetProcessWindowStation(), thread=GetThreadDesktop(GetCurrentThreadId());
  IntPtr input=OpenInputDesktop(0,false,1);
  try { return new object[] {sid,state,Name(station),Value(station,1,8,12),Name(thread),
                             input!=IntPtr.Zero,input==IntPtr.Zero?null:Name(input),Value(thread,6,0,4)}; }
  finally {if(input!=IntPtr.Zero) CloseDesktop(input);}
 }
}
'@
 }
 $v=[Q18DesktopProbe]::Probe()
 $interactive=$v[0] -gt 0 -and $v[1] -eq 0 -and $v[2] -ceq 'WinSta0' -and $v[3] -ge 0 -and ($v[3] -band 1) -eq 1 -and $v[4] -ceq 'Default' -and $v[5] -eq $true -and $v[6] -ceq 'Default' -and $v[7] -eq 1
 [ordered]@{observedUTC=[DateTime]::UtcNow.ToString('o');sessionId=$v[0];wtsState=$v[1];windowStation=$v[2];
  stationFlags=$v[3];threadDesktop=$v[4];inputDesktopOpened=$v[5];inputDesktop=$v[6];threadReceivesInput=$v[7];
  interactive=[bool]$interactive;nativeAcceptance='UNRUN';reason=$(if($interactive){'INTERACTIVE_ADMITTED_NOT_NATIVE_PASS'}else{'NONINTERACTIVE_OR_UNPROVEN_BLOCKED'});
  scope='Remote runner current-session query only; no desktop switching, process launch or UI action'}
}
