<#
  Cambia la versión del Portal del Conductor en todos los sitios a la vez.

  La versión vive en tres archivos que deben coincidir:
    js/portal-config.js  APP_VERSION  la que ve el conductor
    sw.js                VERSION      su cambio es lo que avisa a los teléfonos
    index.html           ?v=          evita que el navegador use CSS/JS viejos

  Uso, desde la carpeta portal:
    powershell -ExecutionPolicy Bypass -File .\nueva-version.ps1 1.6.1

  Después se hace commit y push. Los teléfonos la reciben solos.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

$Version = $Version.Trim().TrimStart("v", "V")
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "Versión inválida: '$Version'. Use tres números, por ejemplo 1.6.1"
  exit 1
}

$utf8SinBom = New-Object System.Text.UTF8Encoding($false)

$cambios = @(
  @{ Archivo = "js/portal-config.js"; Patron = 'APP_VERSION: "v\d+\.\d+\.\d+"'; Nuevo = "APP_VERSION: `"v$Version`""; Exactos = 1 },
  @{ Archivo = "sw.js"; Patron = 'const VERSION = "v\d+\.\d+\.\d+";'; Nuevo = "const VERSION = `"v$Version`";"; Exactos = 1 },
  @{ Archivo = "index.html"; Patron = '\?v=\d+\.\d+\.\d+'; Nuevo = "?v=$Version"; Exactos = 0 }
)

# Primero se comprueba todo y después se escribe: si un archivo no tiene lo
# que se espera, no queda ninguno cambiado a medias.
$listos = @()
foreach ($c in $cambios) {
  $ruta = Join-Path $PSScriptRoot $c.Archivo
  if (-not (Test-Path $ruta)) {
    Write-Error "No existe $($c.Archivo)"
    exit 1
  }
  $texto = [System.IO.File]::ReadAllText($ruta, $utf8SinBom)
  $hallados = [regex]::Matches($texto, $c.Patron).Count
  if ($hallados -eq 0 -or ($c.Exactos -gt 0 -and $hallados -ne $c.Exactos)) {
    Write-Error "$($c.Archivo): se esperaba la versión y se encontraron $hallados coincidencias. No se cambió nada."
    exit 1
  }
  $antes = [regex]::Match($texto, $c.Patron).Value
  $listos += @{ Ruta = $ruta; Archivo = $c.Archivo; Antes = $antes; Hallados = $hallados;
                Texto = [regex]::Replace($texto, $c.Patron, $c.Nuevo) }
}

foreach ($l in $listos) {
  [System.IO.File]::WriteAllText($l.Ruta, $l.Texto, $utf8SinBom)
  Write-Host ("  {0,-22} {1}  ->  v{2}  ({3} sitio(s))" -f $l.Archivo, $l.Antes, $Version, $l.Hallados)
}

Write-Host ""
Write-Host "Versión v$Version lista. Falta: git commit y git push."
