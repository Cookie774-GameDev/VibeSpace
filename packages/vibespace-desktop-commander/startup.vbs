Option Explicit
Dim shell, quote, command, files
If WScript.Arguments.Count <> 3 Then WScript.Quit 1
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
' Resolve compact registry arguments from this verified package, not the Windows login directory.
shell.CurrentDirectory = files.GetParentFolderName(WScript.ScriptFullName)
quote = Chr(34)
command = quote & WScript.Arguments(0) & quote & " " & quote & WScript.Arguments(1) & quote & " " & quote & WScript.Arguments(2) & quote
shell.Run command, 0, False
