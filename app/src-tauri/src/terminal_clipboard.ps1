$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# A single clipboard snapshot preserves format precedence and avoids mixed reads.
$snapshot = [System.Windows.Forms.Clipboard]::GetDataObject()
$result = @{ text = ''; paths = @() }
if ($null -ne $snapshot) {
    if ($snapshot.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $result.paths = @($snapshot.GetData([System.Windows.Forms.DataFormats]::FileDrop))
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
