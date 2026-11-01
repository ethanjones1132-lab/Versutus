# Generates the launcher, splash, favicon and notification assets from the
# in-app Versutus mark. Kept in the repo so the binary assets are reproducible:
# run `powershell -ExecutionPolicy Bypass -File scripts/generate-brand-assets.ps1`.
#
# The previous adaptive foreground and monochrome files were the full-bleed
# colour icon, and the adaptive background was a design template with dashed
# guides. Android masks the foreground, so those files made the launcher icon a
# white-cornered square and themed icons a solid block.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$images = Join-Path $root 'assets/images'
$ink = [System.Drawing.ColorTranslator]::FromHtml('#0A0A0B')
$stage = [System.Drawing.ColorTranslator]::FromHtml('#08080A')
$white = [System.Drawing.ColorTranslator]::FromHtml('#F5F7FA')
$violet = [System.Drawing.ColorTranslator]::FromHtml('#8B7CFF')
$violetDeep = [System.Drawing.ColorTranslator]::FromHtml('#6B5CF0')

function New-Canvas([int]$size, [bool]$opaque) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  if ($opaque) {
    $g.Clear($stage)
  } else {
    $g.Clear([System.Drawing.Color]::Transparent)
  }
  return @{ Bitmap = $bmp; Graphics = $g }
}

function Add-RoundedRect($path, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
}

function Draw-Glyph($g, [float]$cx, [float]$cy, [float]$scale, [System.Drawing.Color]$color, [bool]$cutoutInner) {
  $pen = New-Object System.Drawing.Pen($color, (3.5 * $scale))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  # V, from the same unit geometry as components/brand/versutus-mark.tsx.
  $g.DrawLine($pen, $cx + (22 - 38) * $scale, $cy + (26 - 38) * $scale, $cx, $cy + (54 - 38) * $scale)
  $g.DrawLine($pen, $cx, $cy + (54 - 38) * $scale, $cx + (54 - 38) * $scale, $cy + (26 - 38) * $scale)
  $pen.Dispose()

  # The short stem and the orbit dot.
  $stem = New-Object System.Drawing.Pen($color, (2 * $scale))
  $stem.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $stem.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($stem, $cx, $cy + (22 - 38) * $scale, $cx, $cy + (30 - 38) * $scale)
  $stem.Dispose()

  $orbit = New-Object System.Drawing.SolidBrush($color)
  $r = 5 * $scale
  $g.FillEllipse($orbit, $cx - $r, $cy + (18 - 38) * $scale - $r, $r * 2, $r * 2)
  $orbit.Dispose()

  if ($cutoutInner) {
    $old = $g.CompositingMode
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $clear = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Transparent)
    $ir = 2 * $scale
    $g.FillEllipse($clear, $cx - $ir, $cy + (18 - 38) * $scale - $ir, $ir * 2, $ir * 2)
    $clear.Dispose()
    $g.CompositingMode = $old
  } else {
    $inner = New-Object System.Drawing.SolidBrush($ink)
    $ir = 2 * $scale
    $g.FillEllipse($inner, $cx - $ir, $cy + (18 - 38) * $scale - $ir, $ir * 2, $ir * 2)
    $inner.Dispose()
  }
}

function Draw-Tile($g, [int]$size, [bool]$transparentOutside) {
  $tile = 760
  $origin = [float](($size - $tile) / 2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect $path $origin $origin $tile $tile 180
  $rect = New-Object System.Drawing.RectangleF($origin, $origin, $tile, $tile)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $violet, $violetDeep, 45)
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
  Draw-Glyph $g ($size / 2) ($size / 2) 10 $white $false
}

function Save-Png($canvas, [string]$path) {
  $canvas.Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Graphics.Dispose()
  $canvas.Bitmap.Dispose()
}

# 1024 iOS / Play listing icon: full-bleed stage, violet tile, white mark.
$c = New-Canvas 1024 $true
Draw-Tile $c.Graphics 1024 $false
Save-Png $c (Join-Path $images 'icon.png')

# Adaptive foreground and monochrome: glyph only, transparent outside, well
# inside Android's 66% safe zone. The launcher supplies the background.
$c = New-Canvas 1024 $false
Draw-Glyph $c.Graphics 512 512 12.5 $white $true
Save-Png $c (Join-Path $images 'android-icon-foreground.png')

$c = New-Canvas 1024 $false
Draw-Glyph $c.Graphics 512 512 12.5 $white $true
Save-Png $c (Join-Path $images 'android-icon-monochrome.png')

# A real background (the old file was a dashed design template).
$c = New-Canvas 1024 $true
Save-Png $c (Join-Path $images 'android-icon-background.png')

# Splash image sits on the #08080A splash background, so the tile's outside is
# transparent rather than a second, slightly different black square.
$c = New-Canvas 1024 $false
Draw-Tile $c.Graphics 1024 $true
Save-Png $c (Join-Path $images 'splash-icon.png')

# Status-bar notification icon: alpha silhouette only, white for Android to
# tint; no tile, because the status bar shows a monochrome glyph.
$c = New-Canvas 96 $false
Draw-Glyph $c.Graphics 48 48 1.6 $white $true
Save-Png $c (Join-Path $images 'notification-icon.png')

# A small favicon rather than shipping the 386 KB launcher file as the tab icon.
$icon = [System.Drawing.Image]::FromFile((Join-Path $images 'icon.png'))
$favicon = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$fg = [System.Drawing.Graphics]::FromImage($favicon)
$fg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$fg.DrawImage($icon, 0, 0, 512, 512)
$favicon.Save((Join-Path $images 'favicon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$fg.Dispose()
$favicon.Dispose()
$icon.Dispose()

Write-Output 'Brand assets written to assets/images.'
