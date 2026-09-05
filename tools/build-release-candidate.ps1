param(
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$candidateRoot = [System.IO.Path]::GetFullPath($Destination)
$tempPrefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $candidateRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "候选目录必须位于系统临时目录：$candidateRoot"
}
if (Test-Path -LiteralPath $candidateRoot) {
    throw "候选目录已存在，拒绝覆盖：$candidateRoot"
}

$releaseVersion = (Get-Content -LiteralPath (Join-Path $workspaceRoot "VERSION") -Raw).Trim()
# The public GitHub candidate deliberately carries only the legal empty seed.
# Official image-generation content is distributed through the existing backup
# export/import flow, so do not regenerate modes or copy fixed-case media here.

$include = @(
    ".gitignore",
    "VERSION",
    "backup_transfer.py",
    "main.py",
    "image_generation_cleanup.py",
    "image_generation_examples.py",
    "image_generation_media.py",
    "image_generation_modes.py",
    "image_generation_store.py",
    "main_image_v4.py",
    "storage_cleanup.py",
    "static/angle.html",
    "static/api-settings.html",
    "static/asset-manager.html",
    "static/canvas-list.html",
    "static/canvas.html",
    "static/comfyui-settings.html",
    "static/css/asset-manager.css",
    "static/css/backup-manager.css",
    "static/css/canvas-list.css",
    "static/css/canvas.css",
    "static/css/detail-page.css",
    "static/css/image-generation.css",
    "static/css/main-image.css",
    "static/data/image-generation-presets.v1.json",
    "static/update-notes.json",
    "static/detail-page.html",
    "static/enhance.html",
    "static/gpt-chat.html",
    "static/image-generation.html",
    "static/index.html",
    "static/klein.html",
    "static/js/asset-manager.js",
    "static/js/backup-manager.js",
    "static/js/canvas.js",
    "static/js/classic-canvas-performance.js",
    "static/js/detail-page.js",
    "static/js/i18n.js",
    "static/js/i18n/common.js",
    "static/js/image-generation.js",
    "static/js/main-image.js",
    "static/js/smart-canvas.js",
    "static/main-image.html",
    "static/online.html",
    "static/smart-canvas.html",
    "static/zimage.html",
    "tests/__init__.py",
    "tests/asset_manager_selection_labels.test.cjs",
    "tests/backup_manager.test.cjs",
    "tests/banana_fixed_resolution_ui.test.cjs",
    "tests/canvas_alt_drag.test.cjs",
    "tests/canvas_orphan_assets.test.cjs",
    "tests/canvas_delete_reconcile.test.cjs",
    "tests/test_canvas_assets.py",
    "tests/classic_canvas_performance.test.cjs",
    "tests/classic_canvas_view_controls.test.cjs",
    "tests/classic_canvas_wheel.test.cjs",
    "tests/detail_page_backup_manager.test.cjs",
    "tests/custom_distribution_identity.test.cjs",
    "tests/image_generation_admin_ui.test.cjs",
    "tests/image_generation_backup_manager.test.cjs",
    "tests/image_generation_page.test.cjs",
    "tests/main_image_page.test.cjs",
    "tests/studio_sidebar_order.test.cjs",
    "tests/test_detail_page_async_recovery.py",
    "tests/test_detail_page_tasks.py",
    "tests/test_fastapi_lifespan.py",
    "tests/test_backup_transfer.py",
    "tests/test_banana_image_params.py",
    "tests/test_image_generation_admin.py",
    "tests/test_image_generation_backup.py",
    "tests/test_image_generation_media.py",
    "tests/test_image_generation_examples.py",
    "tests/test_image_generation_modes.py",
    "tests/test_image_generation_store.py",
    "tests/test_image_generation_tasks.py",
    "tests/image_generation_test_seed.py",
    "tests/test_image_generation_official_distribution.py",
    "tests/test_main_image_backup.py",
    "tests/test_main_image_tasks.py",
    "tests/test_media_preview_dedup.py",
    "tests/test_storage_cleanup.py",
    "tests/test_storage_cleanup_transaction.py",
    "tests/one_click_delete_ui.test.cjs",
    "tools/build-release-candidate.ps1",
    "tools/export-image-generation-presets.py",
    "项目制作状态.md",
    "发布候选文件清单.md"
)

$archivePath = "$candidateRoot.zip"
New-Item -ItemType Directory -Path $candidateRoot | Out-Null

try {
    & git -C $workspaceRoot archive --format=zip --output=$archivePath HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "git archive 失败，退出码：$LASTEXITCODE"
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $candidateRoot
}
finally {
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
}

foreach ($relativePath in $include) {
    $source = Join-Path $workspaceRoot $relativePath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "白名单文件不存在：$relativePath"
    }
    $destination = Join-Path $candidateRoot $relativePath
    if (Test-Path -LiteralPath $source -PathType Container) {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    } else {
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

# Official modes and fixed example media are deliberately absent from the
# public candidate.  They travel only through the backup export/import flow.
$candidateExampleRoot = Join-Path $candidateRoot "static/image-generation-examples"
if (Test-Path -LiteralPath $candidateExampleRoot) {
    Remove-Item -LiteralPath $candidateExampleRoot -Recurse -Force
}

$candidateManifestPath = Join-Path $candidateRoot "static/data/image-generation-presets.v1.json"
$candidateManifest = Get-Content -LiteralPath $candidateManifestPath -Raw | ConvertFrom-Json

$missing = @($include | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $candidateRoot $_))
})
if ($missing.Count -gt 0) {
    throw "候选树缺少白名单文件：$($missing -join ', ')"
}

$forbidden = @(
    ".planning",
    ".playwright-cli",
    ".superpowers",
    "_modelscope_sync_once.py",
    "design-qa.md",
    "docs/superpowers",
    "history.json",
    "el.click()"
)
$presentForbidden = @($forbidden | Where-Object {
    Test-Path -LiteralPath (Join-Path $candidateRoot $_)
})
if ($presentForbidden.Count -gt 0) {
    throw "候选树包含禁止路径：$($presentForbidden -join ', ')"
}

$headEnvBlob = (& git -C $workspaceRoot rev-parse "HEAD:API/.env").Trim()
$candidateEnvBlob = (& git -C $workspaceRoot hash-object (Join-Path $candidateRoot "API/.env")).Trim()
$headAssetBlob = (& git -C $workspaceRoot rev-parse "HEAD:data/asset_library.json").Trim()
$candidateAssetBlob = (& git -C $workspaceRoot hash-object (Join-Path $candidateRoot "data/asset_library.json")).Trim()

if ($headEnvBlob -ne $candidateEnvBlob) {
    throw "候选树的 API/.env 不是 HEAD 安全基线"
}
if ($headAssetBlob -ne $candidateAssetBlob) {
    throw "候选树的素材库不是 HEAD 安全基线"
}

$candidateFiles = @(Get-ChildItem -LiteralPath $candidateRoot -File -Recurse)
$totalBytes = ($candidateFiles | Measure-Object -Property Length -Sum).Sum

[pscustomobject]@{
    candidate = $candidateRoot
    image_generation_distribution_version = [string]$candidateManifest.distribution_version
    whitelist_files = $include.Count
    total_files = $candidateFiles.Count
    total_bytes = $totalBytes
    api_env_baseline_preserved = ($headEnvBlob -eq $candidateEnvBlob)
    asset_library_baseline_preserved = ($headAssetBlob -eq $candidateAssetBlob)
    forbidden_paths_present = $presentForbidden.Count
} | ConvertTo-Json -Compress
