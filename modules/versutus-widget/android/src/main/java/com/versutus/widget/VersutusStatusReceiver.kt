package com.versutus.widget

import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

class VersutusStatusReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = VersutusStatusWidget()
}
