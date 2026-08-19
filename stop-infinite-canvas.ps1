param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [switch]$ForcePortOwner,
    [ValidateRange(1, 10)]
    [int]$MaxAttempts = 3
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$appDirSource = if ($env:INFINITE_CANVAS_APP_DIR) { $env:INFINITE_CANVAS_APP_DIR } else { $PSScriptRoot }
$appDir = [IO.Path]::GetFullPath($appDirSource).TrimEnd([char]92, [char]47)
$appPython = [IO.Path]::GetFullPath((Join-Path $appDir "python\python.exe"))

function Get-ProcessInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
}

function Test-InfiniteCanvasProcess($ProcessInfo) {
    if (-not $ProcessInfo) {
        return $false
    }

    $command = [string]$ProcessInfo.CommandLine
    if ($command -notmatch "(?i)\bmain\.py\b") {
        return $false
    }

    $executable = ""
    if ($ProcessInfo.ExecutablePath) {
        try {
            $executable = [IO.Path]::GetFullPath([string]$ProcessInfo.ExecutablePath)
        } catch {
            $executable = [string]$ProcessInfo.ExecutablePath
        }
    }
    if ($executable -ieq $appPython) {
        return $true
    }
    if ($command.IndexOf($appDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
    }

    $parent = Get-ProcessInfo ([int]$ProcessInfo.ParentProcessId)
    $parentCommand = [string]$parent.CommandLine
    return $parentCommand.IndexOf($appDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-PortListeners {
    @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
}

function Stop-ExactProcess($ProcessInfo, [string]$Description) {
    try {
        Stop-Process -Id ([int]$ProcessInfo.ProcessId) -Force -ErrorAction Stop
        Write-Host ("已停止{0}，PID：{1}" -f $Description, $ProcessInfo.ProcessId) -ForegroundColor Green
        return $true
    } catch {
        Write-Host ("停止失败，PID：{0}。原因：{1}" -f $ProcessInfo.ProcessId, $_.Exception.Message) -ForegroundColor Red
        return $false
    }
}

Write-Host "正在检查 Infinite Canvas 服务..." -ForegroundColor Cyan
Write-Host ""

# 防止用户刚停止服务，之前安排的一键更新任务又把它重新启动。
$restartJobs = @(
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $command = [string]$_.CommandLine
            $command.IndexOf($appDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $command -like "*_self_restart.bat*"
        }
)
foreach ($restartJob in $restartJobs) {
    Stop-Process -Id ([int]$restartJob.ProcessId) -Force -ErrorAction SilentlyContinue
}
if ($restartJobs.Count -gt 0) {
    Write-Host ("已取消 {0} 个等待执行的自动重启任务。" -f $restartJobs.Count) -ForegroundColor Yellow
}

$listenerIds = @(Get-PortListeners)
if ($listenerIds.Count -eq 0) {
    Write-Host ("服务未运行：{0} 端口当前没有被占用。" -f $Port) -ForegroundColor Yellow
    exit 0
}

if ($ForcePortOwner) {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $listenerIds = @(Get-PortListeners)
        if ($listenerIds.Count -eq 0) {
            Write-Host ("处理成功：{0} 端口已经释放。" -f $Port) -ForegroundColor Green
            exit 0
        }

        Write-Host ("检测到 {0} 端口被占用，正在清理（第 {1}/{2} 轮）..." -f $Port, $attempt, $MaxAttempts) -ForegroundColor Yellow
        foreach ($processId in $listenerIds) {
            $processInfo = Get-ProcessInfo ([int]$processId)
            if (-not $processInfo) {
                Write-Host ("PID {0} 已经退出，等待端口状态更新。" -f $processId) -ForegroundColor Yellow
                continue
            }

            $processName = if ($processInfo.Name) { [string]$processInfo.Name } else { "未知程序" }
            $processPath = if ($processInfo.ExecutablePath) { [string]$processInfo.ExecutablePath } else { "路径不可用" }
            Write-Host ("程序：{0}" -f $processName)
            Write-Host ("PID： {0}" -f $processId)
            Write-Host ("路径：{0}" -f $processPath)
            [void](Stop-ExactProcess $processInfo "占用端口的程序")
        }

        Start-Sleep -Milliseconds 700
    }

    $remaining = @(Get-PortListeners)
    if ($remaining.Count -eq 0) {
        Write-Host ("处理成功：{0} 端口已经释放。" -f $Port) -ForegroundColor Green
        exit 0
    }

    Write-Host ""
    Write-Host ("清理失败：{0} 端口仍被占用。" -f $Port) -ForegroundColor Red
    foreach ($processId in $remaining) {
        $processInfo = Get-ProcessInfo ([int]$processId)
        $processName = if ($processInfo -and $processInfo.Name) { [string]$processInfo.Name } else { "未知程序" }
        $processPath = if ($processInfo -and $processInfo.ExecutablePath) { [string]$processInfo.ExecutablePath } else { "路径不可用" }
        Write-Host ("程序：{0}，PID：{1}，路径：{2}" -f $processName, $processId, $processPath) -ForegroundColor Yellow
    }
    Write-Host "请使用管理员身份重新运行启动服务。" -ForegroundColor Yellow
    exit 1
}

$ownProcesses = @()
$otherProcesses = @()
foreach ($processId in $listenerIds) {
    $processInfo = Get-ProcessInfo ([int]$processId)
    if (Test-InfiniteCanvasProcess $processInfo) {
        $ownProcesses += $processInfo
    } else {
        $otherProcesses += $processInfo
    }
}

$failed = $false
foreach ($processInfo in $ownProcesses) {
    if (-not (Stop-ExactProcess $processInfo "当前 Infinite Canvas 服务")) {
        $failed = $true
    }
}

foreach ($processInfo in $otherProcesses) {
    $processId = if ($processInfo) { [int]$processInfo.ProcessId } else { 0 }
    $processName = if ($processInfo.Name) { [string]$processInfo.Name } else { "未知程序" }
    $processPath = if ($processInfo.ExecutablePath) { [string]$processInfo.ExecutablePath } else { "路径不可用" }

    Write-Host ""
    Write-Host ("发现其他程序占用 {0} 端口：" -f $Port) -ForegroundColor Yellow
    Write-Host ("程序：{0}" -f $processName)
    Write-Host ("PID： {0}" -f $processId)
    Write-Host ("路径：{0}" -f $processPath)
    Write-Host ""
    Write-Host "请选择：" -ForegroundColor Cyan
    Write-Host "  1  强制停止这个程序"
    Write-Host "  2  放弃（推荐，不影响其他程序）"
    $choice = (Read-Host "请输入 1 或 2，直接回车等同于放弃").Trim()

    if ($choice -eq "1") {
        if ($processInfo -and (Stop-ExactProcess $processInfo "占用端口的其他程序")) {
            continue
        }
        $failed = $true
    } else {
        Write-Host "已放弃停止，没有改动这个程序。" -ForegroundColor Yellow
    }
}

Start-Sleep -Milliseconds 500
$remaining = @(Get-PortListeners)
if ($remaining.Count -eq 0) {
    Write-Host ""
    Write-Host ("处理成功：{0} 端口已经释放。" -f $Port) -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host ("{0} 端口仍被占用，PID：{1}" -f $Port, ($remaining -join ", ")) -ForegroundColor Yellow
if ($failed) {
    exit 1
}
exit 2
