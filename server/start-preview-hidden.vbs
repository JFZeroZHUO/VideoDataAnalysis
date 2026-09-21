Option Explicit

Dim shell, request, fileSystem, scriptDir, projectDir, nodePath, command

Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectDir = fileSystem.GetParentFolderName(scriptDir)
nodePath = "C:\Program Files\nodejs\node.exe"

' Avoid starting a second server when the preview is already healthy.
On Error Resume Next
Set request = CreateObject("MSXML2.XMLHTTP")
request.Open "GET", "http://127.0.0.1:4318/api/health", False
request.Send
If Err.Number = 0 And request.Status = 200 Then
  WScript.Quit 0
End If
Err.Clear
On Error GoTo 0

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectDir
command = "cmd.exe /d /c " & Chr(34) & Chr(34) & nodePath & Chr(34) & " server\index.mjs" & Chr(34)

' Window style 0 keeps the preview server hidden; False detaches it from this launcher.
shell.Run command, 0, False
