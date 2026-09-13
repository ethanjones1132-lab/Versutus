package com.versutus.widget

enum class WidgetVariant { SMALL, MEDIUM, LARGE }

/** Which layout a placed widget's current size gets. Pure, JVM-tested. */
object WidgetLayout {
  fun variantFor(widthDp: Float, heightDp: Float): WidgetVariant = when {
    widthDp < 180f -> WidgetVariant.SMALL
    heightDp < 180f -> WidgetVariant.MEDIUM
    else -> WidgetVariant.LARGE
  }
}
