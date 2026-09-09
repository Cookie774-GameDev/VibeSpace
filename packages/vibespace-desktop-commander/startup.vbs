Option Explicit
Dim shell, quote, command
If WScript.Arguments.Count <> 3 Then WScript.Quit 1
Set shell = CreateObject("WScript.Shell")
quote = Chr(34)
command = quote & WScript.Arguments(0) & quote & " " & quote & WScript.Arguments(1) & quote & " " & quote & WScript.Arguments(2) & quote
shell.Run command, 0, False
