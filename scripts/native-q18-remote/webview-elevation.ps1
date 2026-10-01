# Current-process token query only. No impersonation, de-elevation or other process access.
function Get-WebViewElevationFacts([object]$QuerySucceeded,[object]$Elevated,[object]$IntegrityRID){
 $typed=$QuerySucceeded -is [bool] -and $QuerySucceeded -and $Elevated -is [bool] -and
  ($IntegrityRID -is [int] -or $IntegrityRID -is [long])
 $known=$typed -and $IntegrityRID -in @(0x0000,0x1000,0x2000,0x2100,0x3000,0x4000,0x5000)
 $admitted=$known -and -not $Elevated -and $IntegrityRID -in @(0x2000,0x2100)
 $reason=if(-not $known){'TOKEN_UNPROVEN_BLOCKED'}
  elseif($Elevated -or $IntegrityRID -ge 0x3000){'ELEVATED_WEBVIEW_ENV_OVERRIDES_IGNORED'}
  elseif(-not $admitted){'NONSTANDARD_INTEGRITY_BLOCKED'}else{'STANDARD_TOKEN_ENV_OVERRIDE_PATH_ADMITTED'}
 [ordered]@{querySucceeded=[bool]$known;elevated=$(if($known){[bool]$Elevated}else{$null});
  integrityRID=$(if($known){[int]$IntegrityRID}else{$null});envOverrideLaunchAdmitted=[bool]$admitted;
  reason=$reason;nativeAcceptance='UNRUN';
  scope='Current controller token only; no user/SID/privilege list or other process tokens'}
}
function Initialize-Q18CurrentTokenProbe {
 if(-not ('Q18CurrentTokenProbe' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Q18CurrentTokenProbe {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,uint length,out uint needed);
 [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 public static object[] ReadCurrent() {
  IntPtr token=IntPtr.Zero,elevation=IntPtr.Zero,label=IntPtr.Zero;
  try {
   if(!OpenProcessToken(GetCurrentProcess(),8,out token)) return new object[]{false,null,null};
   elevation=Marshal.AllocHGlobal(4);uint needed;
   if(!GetTokenInformation(token,20,elevation,4,out needed)||needed!=4) return new object[]{false,null,null};
   int elevated=Marshal.ReadInt32(elevation);
   if(elevated!=0&&elevated!=1) return new object[]{false,null,null};
   GetTokenInformation(token,25,IntPtr.Zero,0,out needed);
   if(Marshal.GetLastWin32Error()!=122||needed<(uint)(IntPtr.Size+4)||needed>4096) return new object[]{false,null,null};
   label=Marshal.AllocHGlobal((int)needed);uint actual;
   if(!GetTokenInformation(token,25,label,needed,out actual)||actual>needed) return new object[]{false,null,null};
   IntPtr sid=Marshal.ReadIntPtr(label);
   long start=label.ToInt64(),end=start+needed,pointer=sid.ToInt64();
   if(pointer<start||pointer>end-8) return new object[]{false,null,null};
   byte count=Marshal.ReadByte(IntPtr.Add(sid,1));
   if(count<1||count>15||pointer+8L+4L*count>end||!IsValidSid(sid)) return new object[]{false,null,null};
   byte checkedCount=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
   if(checkedCount!=count) return new object[]{false,null,null};
   int rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
   return new object[]{true,elevated==1,rid};
  } catch {return new object[]{false,null,null};}
  finally {
   if(label!=IntPtr.Zero) Marshal.FreeHGlobal(label);
   if(elevation!=IntPtr.Zero) Marshal.FreeHGlobal(elevation);
   if(token!=IntPtr.Zero) CloseHandle(token);
  }
 }
}
'@
 }
}
function Get-RemoteWebViewElevationAdmission {
 if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true'){throw 'consumer_elevation_probe_remote_only'}
 try{
  Initialize-Q18CurrentTokenProbe
  $v=[Q18CurrentTokenProbe]::ReadCurrent()
  $facts=Get-WebViewElevationFacts $v[0] $v[1] $v[2]
 }catch{$facts=Get-WebViewElevationFacts $false $null $null}
 $facts.observedUTC=[DateTime]::UtcNow.ToString('o')
 return $facts
}
