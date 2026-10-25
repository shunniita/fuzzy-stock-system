[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = 4180,

    [switch]$NoBrowser,

    # 配布物の自動テスト専用。通常の起動では指定しない。
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$settingsPath = Join-Path (Split-Path -Parent $root) 'local-settings.txt'

function Read-ConfiguredPort {
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        return 4180
    }

    $settings = @(
        Get-Content -LiteralPath $settingsPath -Encoding UTF8 |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }
    )
    if ($settings.Count -ne 1 -or $settings[0] -notmatch '^port\s*=\s*([0-9]{1,5})$') {
        throw 'port=数字 の行を1行だけ指定してください。'
    }

    $configuredPort = [int]$Matches[1]
    if ($configuredPort -lt 1024 -or $configuredPort -gt 65535) {
        throw 'ポートは1024～65535の範囲で指定してください。'
    }
    return $configuredPort
}

if (-not $PSBoundParameters.ContainsKey('Port')) {
    try {
        $Port = Read-ConfiguredPort
    }
    catch {
        Write-Host 'FS_SETTINGS_INVALID'
        Write-Host 'local-settings.txt の内容が正しくありません。'
        Write-Host $_.Exception.Message
        Write-Host '設定を直してから、start-local.cmd をもう一度ダブルクリックしてください。'
        exit 3
    }
}

$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)

$mimeTypes = @{
    '.css'   = 'text/css; charset=utf-8'
    '.html'  = 'text/html; charset=utf-8'
    '.ico'   = 'image/x-icon'
    '.js'    = 'text/javascript; charset=utf-8'
    '.json'  = 'application/json; charset=utf-8'
    '.map'   = 'application/json; charset=utf-8'
    '.md'    = 'text/markdown; charset=utf-8'
    '.mjs'   = 'text/javascript; charset=utf-8'
    '.png'   = 'image/png'
    '.svg'   = 'image/svg+xml; charset=utf-8'
    '.txt'   = 'text/plain; charset=utf-8'
    '.woff2' = 'font/woff2'
}

function Write-HttpResponse {
    param(
        [Parameter(Mandatory = $true)] [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)] [int]$StatusCode,
        [Parameter(Mandatory = $true)] [string]$Reason,
        [Parameter(Mandatory = $true)] [byte[]]$Body,
        [string]$ContentType = 'text/plain; charset=utf-8',
        [switch]$HeadOnly,
        [string[]]$ExtraHeaders = @()
    )

    $lines = @(
        "HTTP/1.1 $StatusCode $Reason"
        "Content-Type: $ContentType"
        "Content-Length: $($Body.Length)"
        'Cache-Control: no-store'
        'X-Content-Type-Options: nosniff'
        'Connection: close'
    ) + $ExtraHeaders + @('', '')
    $header = [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n"))
    $Stream.Write($header, 0, $header.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) {
        # 64KBを超える本体を一度に書くと、並列に読まれたときに65,280バイトで接続が切れることがある（2026-10-09に実測）。分けて書く。
        for ($offset = 0; $offset -lt $Body.Length; $offset += 8192) {
            $Stream.Write($Body, $offset, [Math]::Min(8192, $Body.Length - $offset))
        }
    }
    $Stream.Flush()
}

function Write-TextResponse {
    param(
        [Parameter(Mandatory = $true)] [IO.Stream]$Stream,
        [Parameter(Mandatory = $true)] [int]$StatusCode,
        [Parameter(Mandatory = $true)] [string]$Reason,
        [Parameter(Mandatory = $true)] [string]$Message,
        [switch]$HeadOnly,
        [string[]]$ExtraHeaders = @()
    )

    $body = [Text.Encoding]::UTF8.GetBytes($Message)
    Write-HttpResponse -Stream $Stream -StatusCode $StatusCode -Reason $Reason -Body $body `
        -ContentType 'text/plain; charset=utf-8' -HeadOnly:$HeadOnly -ExtraHeaders $ExtraHeaders
}

function Handle-Request {
    param([Parameter(Mandatory = $true)] [Net.Sockets.TcpClient]$Client)

    $stream = $Client.GetStream()
    $stream.ReadTimeout = 5000
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine) -or $requestLine.Length -gt 8192) {
        Write-TextResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' -Message 'Bad request.'
        return
    }

    $headerSize = $requestLine.Length
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line.Length -eq 0) { break }
        $headerSize += $line.Length
        if ($headerSize -gt 32768) {
            Write-TextResponse -Stream $stream -StatusCode 431 -Reason 'Request Header Fields Too Large' -Message 'Headers too large.'
            return
        }
    }

    $parts = $requestLine.Split(' ')
    if ($parts.Length -ne 3) {
        Write-TextResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' -Message 'Bad request.'
        return
    }

    $method = $parts[0].ToUpperInvariant()
    $headOnly = $method -eq 'HEAD'
    if ($method -ne 'GET' -and -not $headOnly) {
        Write-TextResponse -Stream $stream -StatusCode 405 -Reason 'Method Not Allowed' -Message 'Only GET and HEAD are supported.' `
            -ExtraHeaders @('Allow: GET, HEAD')
        return
    }

    try {
        $requestPath = $parts[1].Split('?')[0]
        $decodedPath = [Uri]::UnescapeDataString($requestPath)
    }
    catch {
        Write-TextResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' -Message 'Invalid URL.' -HeadOnly:$headOnly
        return
    }

    if ($decodedPath.IndexOf([char]0) -ge 0 -or $decodedPath.Contains(':')) {
        Write-TextResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' -Message 'Invalid path.' -HeadOnly:$headOnly
        return
    }

    $relativePath = $decodedPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
    try {
        $candidate = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
    }
    catch {
        Write-TextResponse -Stream $stream -StatusCode 400 -Reason 'Bad Request' -Message 'Invalid path.' -HeadOnly:$headOnly
        return
    }

    if ($candidate -ne $root -and -not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Write-TextResponse -Stream $stream -StatusCode 403 -Reason 'Forbidden' -Message 'Access denied.' -HeadOnly:$headOnly
        return
    }

    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $candidate = Join-Path $candidate 'index.html'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Write-TextResponse -Stream $stream -StatusCode 404 -Reason 'Not Found' -Message 'Not found.' -HeadOnly:$headOnly
        return
    }

    $extension = [IO.Path]::GetExtension($candidate).ToLowerInvariant()
    if (-not $mimeTypes.ContainsKey($extension)) {
        Write-TextResponse -Stream $stream -StatusCode 415 -Reason 'Unsupported Media Type' -Message 'This file type is not served.' -HeadOnly:$headOnly
        return
    }

    $body = [IO.File]::ReadAllBytes($candidate)
    Write-HttpResponse -Stream $stream -StatusCode 200 -Reason 'OK' -Body $body `
        -ContentType $mimeTypes[$extension] -HeadOnly:$headOnly
}

$waitingClients = New-Object Collections.ArrayList
try {
    try {
        $listener.Start()
    }
    catch [Net.Sockets.SocketException] {
        $socketFailure = $_.Exception.GetBaseException()
        if ($socketFailure.SocketErrorCode -eq [Net.Sockets.SocketError]::AddressAlreadyInUse) {
            Write-Host "FS_PORT_IN_USE $Port"
            Write-Host "ポート $Port は、すでに別のアプリで使われています。"
            Write-Host '起動済みのfuzzy-stock-systemの黒い画面を閉じるか、local-settings.txt でポートを変えてから、もう一度お試しください。'
            exit 2
        }
        Write-Host "FS_SERVER_START_FAILED $($socketFailure.NativeErrorCode) $($socketFailure.SocketErrorCode)"
        Write-Host 'ローカル配信を開始できませんでした。'
        Write-Host "エラー番号: $($socketFailure.NativeErrorCode)"
        Write-Host $socketFailure.Message
        if ($socketFailure.SocketErrorCode -eq [Net.Sockets.SocketError]::AccessDenied) {
            Write-Host 'local-settings.txt でポートを変えると直る場合があります。変更しても起動しない場合は、端末の管理担当者へ確認してください。'
        }
        else {
            Write-Host 'この画面の内容を控え、端末の管理担当者へ確認してください。'
        }
        exit 5
    }

    $actualPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $url = "http://127.0.0.1:$actualPort/"
    Write-Host "FS_SERVER_READY $url"
    Write-Host 'fuzzy-stock-system（この端末のブラウザーに保存）を起動しました。'
    Write-Host "使用ポート: $actualPort（設定ファイル: local-settings.txt）"
    Write-Host "ブラウザーが開かない場合は、次のURLを開いてください: $url"
    Write-Host 'この黒い画面を閉じると配信を終了します。記録は同じアドレス・ブラウザー・プロファイルで再表示できます。復元用バックアップは、画面から保存したファイルを各自で保管してください。'

    if (-not $NoBrowser) {
        try {
            Start-Process $url
        }
        catch {
            Write-Host 'ブラウザーを自動で開けませんでした。上に表示されたURLを開いてください。'
        }
    }

    do {
        if ($Once) {
            $client = $listener.AcceptTcpClient()
        }
        else {
            # ブラウザーの先行接続は要求を送らないことがある。ヘッダーが揃うまで
            # 保留し、別の接続のCSSや起動moduleの配信を止めない。
            if ($waitingClients.Count -eq 0) {
                [void]$waitingClients.Add(@{ Client = $listener.AcceptTcpClient(); Since = [DateTime]::UtcNow })
            }
            while ($listener.Pending()) {
                $accepted = $listener.AcceptTcpClient()
                [void]$waitingClients.Add(@{ Client = $accepted; Since = [DateTime]::UtcNow })
            }
            $client = $null
            for ($i = $waitingClients.Count - 1; $i -ge 0; $i--) {
                $entry = $waitingClients[$i]
                $socket = $entry.Client.Client
                try {
                    $readable = $socket.Poll(0, [Net.Sockets.SelectMode]::SelectRead)
                    $available = $socket.Available
                    $closed = $readable -and $available -eq 0
                    if ($closed -or ([DateTime]::UtcNow - $entry.Since).TotalSeconds -ge 5) {
                        $entry.Client.Close()
                        $waitingClients.RemoveAt($i)
                        continue
                    }
                    if ($available -eq 0) { continue }
                    $buffer = New-Object byte[] ([Math]::Min($available, 32769))
                    $count = $socket.Receive($buffer, 0, $buffer.Length, [Net.Sockets.SocketFlags]::Peek)
                    $header = [Text.Encoding]::ASCII.GetString($buffer, 0, $count)
                    if ($header.Contains("`r`n`r`n") -or $header.Contains("`n`n")) {
                        $client = $entry.Client
                        $waitingClients.RemoveAt($i)
                        break
                    }
                    if ($count -ge 32769) {
                        Write-TextResponse -Stream $entry.Client.GetStream() -StatusCode 431 -Reason 'Request Header Fields Too Large' -Message 'Headers too large.'
                        $entry.Client.Close()
                        $waitingClients.RemoveAt($i)
                    }
                }
                catch {
                    $entry.Client.Close()
                    $waitingClients.RemoveAt($i)
                }
            }
            if ($null -eq $client) {
                Start-Sleep -Milliseconds 10
                continue
            }
        }
        try {
            Handle-Request -Client $client
        }
        catch {
            try {
                Write-TextResponse -Stream $client.GetStream() -StatusCode 500 -Reason 'Internal Server Error' -Message 'Server error.'
            }
            catch { }
        }
        finally {
            $client.Close()
        }
    } while (-not $Once)
}
finally {
    foreach ($entry in $waitingClients) { $entry.Client.Close() }
    $listener.Stop()
}
