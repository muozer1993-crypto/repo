# Ergoterapi — isar_flutter_libs namespace patch (Windows / PowerShell)
#
# isar_flutter_libs 3.x artik bakim almiyor ve yeni Android Gradle
# Plugin'in zorunlu kildigi `namespace` alanini tanimlamiyor. Her
# `flutter pub get` sonrasinda pub cache yenilendiginde bu patch'i
# calistirman gerekir; aksi halde Gradle build'i "Namespace not
# specified" hatasiyla duser.
#
# Kullanim:
#   powershell -ExecutionPolicy Bypass -File scripts\fix_isar_namespace.ps1

$ErrorActionPreference = 'Stop'

# Pub cache Windows'ta iki olasi konumda olabilir. Ikisini de kontrol et.
$pubCacheRoots = @(
    "$env:LOCALAPPDATA\Pub\Cache\hosted\pub.dev",
    "$env:USERPROFILE\AppData\Local\Pub\Cache\hosted\pub.dev"
) | Where-Object { Test-Path $_ } | Select-Object -Unique

if (-not $pubCacheRoots) {
    Write-Error "Pub cache bulunamadi. Once 'flutter pub get' calistir."
    exit 1
}

$patched = $false

foreach ($root in $pubCacheRoots) {
    $isarDirs = Get-ChildItem -Path $root -Directory -Filter 'isar_flutter_libs-*' -ErrorAction SilentlyContinue
    foreach ($dir in $isarDirs) {
        $buildGradle = Join-Path $dir.FullName 'android\build.gradle'
        if (-not (Test-Path $buildGradle)) { continue }

        $content = Get-Content $buildGradle -Raw
        if ($content -match 'namespace\s+') {
            Write-Host "Zaten yamali: $buildGradle"
            $patched = $true
            continue
        }

        # `android {` satirindan hemen sonra namespace satirini ekle.
        $newContent = $content -replace '(?ms)(^android\s*\{)', "`$1`r`n    namespace `"dev.isar.isar_flutter_libs`""
        Set-Content -Path $buildGradle -Value $newContent -NoNewline
        Write-Host "Yamali: $buildGradle"
        $patched = $true
    }
}

if (-not $patched) {
    Write-Warning "isar_flutter_libs pub cache'te bulunamadi."
    exit 1
}

Write-Host "`nTamam. Simdi 'flutter run' calistirabilirsin." -ForegroundColor Green
