package com.versutus.widget

import androidx.glance.appwidget.updateAll
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Stores only a payload the card could draw, and schedules the six-hourly
 * redraw first: a refused write still has to leave the card's date rolling, so
 * the refresh is kept alive whatever the write is judged to be. Pure, so the
 * order is JVM-tested rather than read off a lambda.
 */
internal fun storePayloadIfDrawable(
  json: String,
  scheduleRefresh: () -> Unit,
  write: (String) -> Unit,
): Boolean {
  scheduleRefresh()
  if (WidgetPayload.parse(json) !is WidgetPayload.Parsed.Ok) return false
  write(json)
  return true
}

class VersutusWidgetModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun definition() = ModuleDefinition {
    Name("VersutusWidget")

    // Refuse what the widget could not draw, so a bad write never replaces the
    // last good snapshot the widget is still honestly stamping.
    AsyncFunction("setPayload") { json: String ->
      // No context means no enqueue and no store either; the next write with a
      // context schedules the redraw.
      val context = appContext.reactContext ?: return@AsyncFunction false
      val accepted = storePayloadIfDrawable(
        json,
        write = { WidgetPayloadStore.write(context, json) },
        scheduleRefresh = { WidgetRefreshPolicy.enqueue(context) },
      )
      if (!accepted) return@AsyncFunction false
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
