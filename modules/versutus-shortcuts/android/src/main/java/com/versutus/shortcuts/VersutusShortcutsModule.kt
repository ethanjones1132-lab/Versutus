package com.versutus.shortcuts

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VersutusShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VersutusShortcuts")

    AsyncFunction("setShortcuts") { shortcuts: List<Map<String, Any?>> ->
      donate(shortcuts)
    }

    AsyncFunction("updateShortcuts") { shortcuts: List<Map<String, Any?>> ->
      donate(shortcuts)
    }

    AsyncFunction("donateShortcuts") { shortcuts: List<Map<String, Any?>> ->
      donate(shortcuts)
    }

    AsyncFunction("setDynamicShortcuts") { shortcuts: List<Map<String, Any?>> ->
      donate(shortcuts)
    }
  }

  private fun donate(shortcuts: List<Map<String, Any?>>): Boolean {
    val context = appContext.reactContext ?: return false
    return try {
      val manager = context.getSystemService(Context.SHORTCUT_SERVICE) as? ShortcutManager ?: return false
      val shortcutInfos = shortcuts.mapNotNull { item ->
        val id = item["id"] as? String ?: return@mapNotNull null
        val shortLabel = item["shortLabel"] as? String ?: id
        val longLabel = item["longLabel"] as? String ?: shortLabel
        val url = item["url"] as? String ?: return@mapNotNull null
        ShortcutInfo.Builder(context, id)
          .setShortLabel(shortLabel.take(10))
          .setLongLabel(longLabel.take(25))
          .setIcon(Icon.createWithResource(context, android.R.mipmap.sym_def_app_icon))
          .setIntent(
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
              setPackage(context.packageName)
            },
          )
          .build()
      }
      manager.setDynamicShortcuts(shortcutInfos)
      true
    } catch (_: Throwable) {
      false
    }
  }
}
