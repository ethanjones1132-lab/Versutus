package com.versutus.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.glance.state.PreferencesGlanceStateDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Lets each placed widget pin one Bot, stored as that instance's own Glance
 * state. With no Bot pinned the card keeps drawing every quick-launch row;
 * pinning one narrows the card to that Bot alone.
 */
class WidgetConfigureActivity : Activity() {
  private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  private val scope = MainScope()
  private var saving = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setResult(RESULT_CANCELED)
    widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 48, 48, 48)
    }
    root.addView(TextView(this).apply { text = "Pin a Bot to this widget" })
    root.addView(button("No Bot (show every row)", null))
    val parsed = WidgetPayload.parse(WidgetPayloadStore.read(this))
    if (parsed is WidgetPayload.Parsed.Ok) {
      for (bot in parsed.payload.bots) root.addView(button(bot.label, bot.id))
    }
    setContentView(root)
  }

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }

  private fun button(label: String, botId: String?): Button =
    Button(this).apply {
      text = label
      gravity = Gravity.START
      setOnClickListener { choose(botId) }
    }

  private fun choose(botId: String?) {
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      finish()
      return
    }
    if (saving) return
    saving = true
    scope.launch {
      try {
        withContext(Dispatchers.IO) {
          val glanceId = GlanceAppWidgetManager(this@WidgetConfigureActivity).getGlanceIdBy(widgetId)
          updateAppWidgetState(this@WidgetConfigureActivity, PreferencesGlanceStateDefinition, glanceId) { prefs ->
            val key = stringPreferencesKey(WidgetConfigState.BOT_KEY)
            val next = prefs.toMutablePreferences()
            if (botId == null) next.remove(key) else next[key] = WidgetConfigState.write(botId)
            next
          }
          VersutusStatusWidget().updateAll(this@WidgetConfigureActivity)
        }
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Toast.makeText(this@WidgetConfigureActivity, "Could not save this widget. Choose a Bot again to retry.", Toast.LENGTH_LONG).show()
      } finally {
        saving = false
      }
    }
  }
}
