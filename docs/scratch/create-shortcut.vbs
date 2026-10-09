Set oWS = WScript.CreateObject("WScript.Shell")
Set oShortcut = oWS.CreateShortcut(oWS.ExpandEnvironmentString("%USERPROFILE%\Desktop") & "\MemoryOS.lnk")
oShortcut.TargetPath = "C:\Users\WYX\Desktop\MemoryOS\start-memoryos.bat"
oShortcut.WorkingDirectory = "C:\Users\WYX\Desktop\MemoryOS"
oShortcut.WindowStyle = 1
oShortcut.Description = "MemoryOS"
oShortcut.Save
