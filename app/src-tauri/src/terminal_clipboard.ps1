$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# A single clipboard snapshot preserves format precedence and avoids mixed reads.
function Read-TerminalClipboard {
$snapshot = [System.Windows.Forms.Clipboard]::GetDataObject()
$result = @{ text = ''; paths = @() }
if ($null -ne $snapshot) {
    if ($snapshot.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $result.paths = @($snapshot.GetData([System.Windows.Forms.DataFormats]::FileDrop) | ForEach-Object {
            $fullPath = [System.IO.Path]::GetFullPath($_)
            if (-not ([System.IO.File]::Exists($fullPath) -or [System.IO.Directory]::Exists($fullPath))) {
                throw 'The copied file no longer exists.'
            }
            $fullPath
        })
    } elseif ($snapshot.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {
        $bitmap = $snapshot.GetData([System.Windows.Forms.DataFormats]::Bitmap)
        try {
            $folder = $env:VIBESPACE_CLIPBOARD_DIR
            [System.IO.Directory]::CreateDirectory($folder) | Out-Null
            $path = [System.IO.Path]::Combine($folder, ([Guid]::NewGuid().ToString('N') + '.png'))
            $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
            $result.paths = @($path)
        } finally { if ($null -ne $bitmap) { $bitmap.Dispose() } }
    } elseif ($snapshot.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText)) {
        $result.text = [string]$snapshot.GetData([System.Windows.Forms.DataFormats]::UnicodeText)
    }
}
ConvertTo-Json -InputObject $result -Compress -Depth 3
}
if ($env:VIBESPACE_CLIPBOARD_SERVER -eq '1') {
    while ($null -ne ($request = [Console]::ReadLine())) {
        try {
            if ($request -ne 'read') { throw 'Invalid clipboard request.' }
            Read-TerminalClipboard
        } catch { [Console]::WriteLine('{"error":"Clipboard unavailable"}') }
        [Console]::Out.Flush()
    }
} else { Read-TerminalClipboard }
