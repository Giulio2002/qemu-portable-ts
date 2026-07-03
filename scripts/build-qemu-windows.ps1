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
# Make native commands (node, curl, tar) fail the script on non-zero exit;
# without this a failing verification step is silently swallowed.
$PSNativeCommandUseErrorActionPreference = $true

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
# QEMU's Windows build runs through the MSYS2 shell. WHPX is enabled
# explicitly so configure FAILS if the Windows Hypervisor Platform headers
# are missing, instead of silently shipping a TCG-only build (the TS args
# layer emits -accel whpx fallback chains and expects it compiled in). The
# MSYS2 environment is selected per architecture: MINGW64 for x64,
# CLANGARM64 for Windows on ARM.
$MsysEnv = if ($env:QEMU_MSYS_ENV) { $env:QEMU_MSYS_ENV } else { "MINGW64" }
# Root of the MSYS2 installation actually provisioned by setup-msys2 (its
# msys2-location output). Never hardcode C:\msys64: x64 runner images ship an
# unrelated preinstalled MSYS2 there (without our toolchain), and arm64
# runners have nothing there at all.
$Msys2Root = if ($env:QEMU_MSYS2_ROOT) { $env:QEMU_MSYS2_ROOT } else { "C:\msys64" }
$Msys2Bash = Join-Path $Msys2Root "usr\bin\bash.exe"
if (-not (Test-Path $Msys2Bash)) {
    throw "bash.exe not found at $Msys2Bash — set QEMU_MSYS2_ROOT to the MSYS2 root (setup-msys2's msys2-location output)"
}
$ConfigureArgs = "--target-list=$TargetList --disable-docs --disable-werror --disable-gtk --disable-sdl --enable-slirp"
if ($MsysEnv -ne "CLANGARM64") {
    # QEMU's WHPX accelerator only exists for x86 hosts; win32-arm64 is
    # TCG-only until upstream grows aarch64 WHPX support.
    $ConfigureArgs += " --enable-whpx"
}
# MSYS2's MinGW toolchains ship no `cc` shim, and QEMU's configure defaults
# to CC=cc — point it at the environment's real compiler explicitly.
$CcName = if ($MsysEnv -eq "CLANGARM64") { "clang" } else { "gcc" }
$CxxName = if ($MsysEnv -eq "CLANGARM64") { "clang++" } else { "g++" }
$BuildScript = @"
set -e
export CC=$CcName CXX=$CxxName
cd '$($WorkDir -replace '\\','/')/qemu-$QemuVersion'
# Apply repo patches, if any.
for p in '$($RepoRoot -replace '\\','/')'/third_party/qemu/patches/*.patch; do
  [ -e "`$p" ] && patch -p1 --forward < "`$p" || true
done
mkdir -p build && cd build
../configure $ConfigureArgs
make -j`$(nproc)
# Stage a full install: build/pc-bios/ only holds generated files, the
# prebuilt firmware blobs (SeaBIOS, VGA/option ROMs) are only laid out by
# make install.
rm -rf dest
make install DESTDIR="`$PWD/dest"
"@
# MSYSTEM tells the MSYS2 login shell which toolchain environment to load.
$env:MSYSTEM = $MsysEnv
& $Msys2Bash -lc $BuildScript
if ($LASTEXITCODE -ne 0) { throw "QEMU build failed (exit $LASTEXITCODE)" }

# --- Assemble the package -------------------------------------------------------
$BuildDir = Join-Path $WorkDir "qemu-$QemuVersion/build"
$DestDir = Join-Path $BuildDir "dest"
$BinDir = Join-Path $PackageDir "bin"
$ShareDir = Join-Path $PackageDir "share/qemu"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $BinDir, $ShareDir
New-Item -ItemType Directory -Force -Path $BinDir, $ShareDir | Out-Null

foreach ($bin in $Binaries) {
    Copy-Item (Join-Path $DestDir "usr/bin/$bin") $BinDir
}
Copy-Item -Recurse (Join-Path $DestDir "usr/share/qemu/*") $ShareDir
node --experimental-strip-types (Join-Path $RepoRoot "scripts/prune-firmware.ts") $PackageDir

# DLLs live next to the executables on Windows. collect-runtime-deps needs
# objdump (MINGW64) or llvm-objdump (CLANGARM64) on PATH to read PE imports.
$DllDir = if ($env:QEMU_DLL_SEARCH_PATH) { $env:QEMU_DLL_SEARCH_PATH } else { Join-Path $Msys2Root "mingw64\bin" }
$env:PATH = "$DllDir;$(Join-Path $Msys2Root 'usr\bin');$env:PATH"
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
