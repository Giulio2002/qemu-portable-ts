# Builds QEMU from the pinned source and assembles the Windows x64 package.
#
# Usage (from an MSYS2/MinGW64-capable runner):
#   pwsh scripts/build-qemu-windows.ps1 -PackageDir packages/qemu-win32-x64
#
# Requirements: MSYS2 with mingw-w64-x86_64 toolchain, glib2, pixman,
# libslirp, ninja, meson, python. CI installs these via msys2/setup-msys2.
param(
    [Parameter(Mandatory = $true)][string]$PackageDir
)
$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageDir = Resolve-Path $PackageDir
$QemuVersion = (Get-Content (Join-Path $RepoRoot "third_party/qemu/QEMU_VERSION")).Trim()
$Tarball = "qemu-$QemuVersion.tar.xz"
$ChecksumFile = Join-Path $RepoRoot "third_party/qemu/checksums/$Tarball.sha256"
$TargetList = "x86_64-softmmu,aarch64-softmmu"
$Binaries = @("qemu-system-x86_64.exe", "qemu-system-aarch64.exe", "qemu-img.exe")

$WorkDir = if ($env:QEMU_BUILD_DIR) { $env:QEMU_BUILD_DIR } else { Join-Path $RepoRoot "third_party/qemu/source" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Set-Location $WorkDir

# --- Fetch and verify pinned source ------------------------------------------
if (-not (Test-Path $Tarball)) {
    Write-Host "Downloading $Tarball ..."
    curl.exe -fL --retry 3 -o $Tarball "https://download.qemu.org/$Tarball"
}
$Expected = (Get-Content $ChecksumFile).Split(" ")[0]
$Actual = (Get-FileHash -Algorithm SHA256 $Tarball).Hash.ToLower()
if ($Actual -ne $Expected) {
    throw "Checksum mismatch for ${Tarball}: expected $Expected, got $Actual"
}

if (-not (Test-Path "qemu-$QemuVersion")) {
    tar xf $Tarball
}

# --- Configure and build under MSYS2 ------------------------------------------
# QEMU's Windows build runs through the MSYS2 shell; --enable-whpx is implied
# by the w64 target when the SDK is present.
$ConfigureArgs = "--target-list=$TargetList --disable-docs --disable-werror --disable-gtk --disable-sdl --enable-slirp"
$BuildScript = @"
set -e
cd '$($WorkDir -replace '\\','/')/qemu-$QemuVersion'
# Apply repo patches, if any.
for p in '$($RepoRoot -replace '\\','/')'/third_party/qemu/patches/*.patch; do
  [ -e "`$p" ] && patch -p1 --forward < "`$p" || true
done
mkdir -p build && cd build
../configure $ConfigureArgs
make -j`$(nproc)
"@
& C:\msys64\usr\bin\bash.exe -lc $BuildScript

# --- Assemble the package -------------------------------------------------------
$BuildDir = Join-Path $WorkDir "qemu-$QemuVersion/build"
$BinDir = Join-Path $PackageDir "bin"
$ShareDir = Join-Path $PackageDir "share/qemu"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $BinDir, $ShareDir
New-Item -ItemType Directory -Force -Path $BinDir, $ShareDir | Out-Null

foreach ($bin in $Binaries) {
    Copy-Item (Join-Path $BuildDir $bin) $BinDir
}
Copy-Item -Recurse (Join-Path $BuildDir "pc-bios/*") $ShareDir

# DLLs live next to the executables on Windows.
node --experimental-strip-types (Join-Path $RepoRoot "scripts/collect-runtime-deps.ts") $PackageDir

# --- Metadata --------------------------------------------------------------------
node --experimental-strip-types (Join-Path $RepoRoot "scripts/generate-build-info.ts") `
    $PackageDir `
    --qemu-version $QemuVersion `
    --git-ref "v$QemuVersion" `
    --source-sha256 $Expected `
    --configure-args ($ConfigureArgs -replace " ", ";") `
    --patches ""

node --experimental-strip-types (Join-Path $RepoRoot "scripts/verify-binary-package.ts") $PackageDir
Write-Host "Package assembled: $PackageDir"
