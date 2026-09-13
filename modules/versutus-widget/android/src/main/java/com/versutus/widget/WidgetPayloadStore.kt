package com.versutus.widget

import android.content.Context

/** App-private storage for the last payload JS wrote. Nothing else reads it. */
internal object WidgetPayloadStore {
  private const val PREFS = "versutus_widget"
  private const val KEY = "payload_v1"

  fun write(context: Context, json: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
  }

  fun read(context: Context): String? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
  }
}
