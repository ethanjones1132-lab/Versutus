package com.versutus.widget

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.glance.material3.ColorProviders

/**
 * The card's colours where the launcher has no dynamic colour (Android < 12).
 * Android 12+ keeps Glance's dynamic scheme; below it these light and dark
 * palettes keep the card opaque and readable on any wallpaper.
 */
object WidgetColors {
  val colors = ColorProviders(
    light = lightColorScheme(
      primary = Color(0xFF1B6B3A),
      onPrimary = Color(0xFFFFFFFF),
      background = Color(0xFFF7F7F9),
      onBackground = Color(0xFF1A1A1C),
      surface = Color(0xFFFFFFFF),
      onSurface = Color(0xFF1A1A1C),
      surfaceVariant = Color(0xFFE4E4E8),
      onSurfaceVariant = Color(0xFF5A5A62),
      error = Color(0xFFB3261E),
    ),
    dark = darkColorScheme(
      primary = Color(0xFF7DD3A0),
      onPrimary = Color(0xFF06210F),
      background = Color(0xFF08080A),
      onBackground = Color(0xFFF5F5F7),
      surface = Color(0xFF17171A),
      onSurface = Color(0xFFF5F5F7),
      surfaceVariant = Color(0xFF2A2A2F),
      onSurfaceVariant = Color(0xFFB0B0B8),
      error = Color(0xFFE5534B),
    ),
  )
}
