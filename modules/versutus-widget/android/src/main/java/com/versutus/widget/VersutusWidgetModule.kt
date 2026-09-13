package com.versutus.widget

import androidx.glance.appwidget.updateAll
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class VersutusWidgetModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun definition() = ModuleDefinition {
    Name("VersutusWidget")

    // Refuse what the widget could not draw, so a bad write never replaces the
    // last good snapshot the widget is still honestly stamping.
    AsyncFunction("setPayload") { json: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (WidgetPayload.parse(json) !is WidgetPayload.Parsed.Ok) return@AsyncFunction false
      WidgetPayloadStore.write(context, json)
      scope.launch { VersutusStatusWidget().updateAll(context) }
      true
    }

    AsyncFunction("clearPayload") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      WidgetPayloadStore.clear(context)
      scope.launch { VersutusStatusWidget().updateAll(context) }
    }
  }
}
