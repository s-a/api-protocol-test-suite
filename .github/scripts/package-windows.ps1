param(
    [Parameter(Mandatory)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$project = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$nodeVersion = & $node --version
if ($nodeVersion -notmatch '^v24\.\d+\.\d+$' -or (& $node -p 'process.platform + "-" + process.arch') -ne 'win32-x64') {
    throw 'Packaging requires Node.js 24 for Windows x64.'
}

$output = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
$tempRoot = (Resolve-Path ([IO.Path]::GetTempPath())).Path
$stage = New-Item -ItemType Directory -Path (Join-Path $tempRoot "api-protocol-package-$([guid]::NewGuid())")
$app = Join-Path $stage.FullName 'app'

function Write-Launcher($Executable) {
    @"
@echo off
setlocal
pushd "%~dp0" || exit /b 1
"$Executable" --use-system-ca --env-file-if-exists=.env apps/server/server.mjs %*
set "exitCode=%errorlevel%"
popd
exit /b %exitCode%
"@ | Set-Content -LiteralPath (Join-Path $app 'start.cmd') -Encoding ascii
}

function Write-Archive($Variant) {
    $name = "api-protocol-test-suite-$Variant-win-x64.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($app, (Join-Path $stage.FullName $name))
}

try {
    $server = (New-Item -ItemType Directory -Path (Join-Path $app 'apps/server') -Force).FullName
    $web = (New-Item -ItemType Directory -Path (Join-Path $app 'apps/web') -Force).FullName
    Get-ChildItem -LiteralPath (Join-Path $project 'apps/server') -File |
        Where-Object { $_.Extension -in '.mjs', '.cjs', '.ts' -and $_.Name -notlike '*.test.*' } |
        Copy-Item -Destination $server
    Copy-Item -LiteralPath (Join-Path $project 'apps/server/favicon.png') -Destination $server
    Copy-Item -LiteralPath (Join-Path $project 'apps/web/dist') -Destination $web -Recurse
    Copy-Item -LiteralPath ('package.json', 'package-lock.json', 'README.md' | ForEach-Object { Join-Path $project $_ }) -Destination $app

    Write-Launcher 'node.exe'
    Write-Archive 'slim'

    Push-Location $app
    try {
        npm.cmd ci --omit=dev
        & .\start.cmd accounts list
    } finally {
        Pop-Location
    }
    Write-Archive 'runtime-bundle'

    $runtime = (New-Item -ItemType Directory -Path (Join-Path $app 'runtime')).FullName
    Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
    $license = Join-Path (Split-Path -Parent $node) 'LICENSE'
    if (Test-Path -LiteralPath $license -PathType Leaf) {
        Copy-Item -LiteralPath $license -Destination $runtime
    } else {
        Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $runtime 'LICENSE')
    }
    Set-Content -LiteralPath (Join-Path $runtime 'VERSION.txt') -Value $nodeVersion -Encoding ascii
    Write-Launcher '%~dp0runtime\node.exe'
    & (Join-Path $app 'start.cmd') accounts list
    Write-Archive 'standalone'

    Get-ChildItem -LiteralPath $stage.FullName -Filter '*.zip' -File | Move-Item -Destination $output -Force
} finally {
    $stagePath = (Resolve-Path -LiteralPath $stage.FullName).Path
    if ((Split-Path -Parent $stagePath) -eq $tempRoot) {
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
}
