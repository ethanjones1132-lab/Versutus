package com.versutus.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import java.time.ZoneId
import java.util.Locale

class VersutusStatusWidget : GlanceAppWidget() {
  override val sizeMode = SizeMode.Responsive(setOf(TINY, SMALL, MEDIUM, LARGE))

  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val parsed = WidgetPayload.parse(WidgetPayloadStore.read(context))
    provideContent {
      GlanceTheme(colors = if (Build.VERSION.SDK_INT >= 31) GlanceTheme.colors else WidgetColors.colors) {
        StatusCard(parsed)
      }
    }
  }

  companion object {
    val TINY = DpSize(57.dp, 57.dp)
    val SMALL = DpSize(110.dp, 110.dp)
    val MEDIUM = DpSize(250.dp, 110.dp)
    val LARGE = DpSize(250.dp, 250.dp)
  }
}

@Composable
private fun StatusCard(parsed: WidgetPayload.Parsed) {
  val context = LocalContext.current
  val size = LocalSize.current
  val variant = WidgetLayout.variantFor(size.width.value, size.height.value)
  val description = when (parsed) {
    is WidgetPayload.Parsed.Ok -> {
      val payload = parsed.payload
      val stamp = WidgetStamp.line(payload.writtenAt, System.currentTimeMillis(), ZoneId.systemDefault(), Locale.getDefault())
      "Versutus: ${payload.status}. ${payload.work}. $stamp"
    }
    WidgetPayload.Parsed.NeedsUpdate -> "Versutus: update the app to show status"
    WidgetPayload.Parsed.Invalid -> "Versutus: open the app to connect"
  }
  Column(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(GlanceTheme.colors.widgetBackground)
      .cornerRadius(android.R.dimen.system_app_widget_background_radius)
      .semantics { contentDescription = description }
      .padding(14.dp)
      .clickable(actionStartActivity(openAppIntent(context, "versutus://chat"))),
  ) {
    when (parsed) {
      is WidgetPayload.Parsed.Ok -> Lines(parsed.payload, variant)
      WidgetPayload.Parsed.NeedsUpdate -> Line("Update Versutus to show status", bold = true)
      WidgetPayload.Parsed.Invalid -> {
        Line("Versutus", bold = true)
        Line("Open Versutus to connect")
      }
    }
  }
}

@Composable
private fun Lines(payload: WidgetPayload, variant: WidgetVariant) {
  if (variant == WidgetVariant.TINY) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Dot(payload.connected)
      Spacer(GlanceModifier.width(6.dp))
      Line(payload.status, bold = true)
    }
    return
  }
  val stamp = WidgetStamp.line(payload.writtenAt, System.currentTimeMillis(), ZoneId.systemDefault(), Locale.getDefault())
  Row(verticalAlignment = Alignment.CenterVertically) {
    Dot(payload.connected)
    Spacer(GlanceModifier.width(6.dp))
    Line(payload.status, bold = true)
  }
  Spacer(GlanceModifier.height(4.dp))
  Line(payload.work)
  if (variant == WidgetVariant.LARGE && payload.runs.isNotEmpty()) {
    for (run in payload.runs) {
      Spacer(GlanceModifier.height(3.dp))
      Line("${run.title} — ${run.state}")
    }
  }
  if (payload.bots.isNotEmpty()) {
    for (bot in payload.bots) {
      Spacer(GlanceModifier.height(3.dp))
      BotRow(bot)
    }
  }
  if (payload.approvalsPending > 0 && variant != WidgetVariant.SMALL) {
    Line("Tap to decide in Versutus", secondary = true)
  }
  if (variant != WidgetVariant.SMALL && payload.result != null) {
    Spacer(GlanceModifier.height(4.dp))
    Line(payload.result, maxLines = if (variant == WidgetVariant.LARGE) 4 else 2)
  }
  Spacer(GlanceModifier.height(6.dp))
  Line(stamp, secondary = true)
}

@Composable
private fun Dot(connected: Boolean) {
  Box(
    modifier = GlanceModifier
      .size(8.dp)
      .cornerRadius(4.dp)
      .background(if (connected) GlanceTheme.colors.primary else GlanceTheme.colors.error),
  ) {}
}

/** One Bot quick-launch row; the tap opens that Bot's chat through the app's router. */
@Composable
private fun BotRow(bot: WidgetBot) {
  val context = LocalContext.current
  Row(
    modifier = GlanceModifier
      .fillMaxWidth()
      .clickable(actionStartActivity(openAppIntent(context, WidgetLinks.botChatUri(bot.id))))
      .padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Line(bot.label)
  }
}

@Composable
private fun Line(text: String, bold: Boolean = false, secondary: Boolean = false, maxLines: Int = 1) {
  Text(
    text = text,
    maxLines = maxLines,
    style = TextStyle(
      color = if (secondary) GlanceTheme.colors.onSurfaceVariant else GlanceTheme.colors.onSurface,
      fontSize = if (bold) 15.sp else if (secondary) 11.sp else 13.sp,
      fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
    ),
  )
}

/** Every tap goes through the app's own `versutus://` router; nothing is decided here. */
internal fun openAppIntent(context: Context, uri: String): Intent =
  Intent(Intent.ACTION_VIEW, Uri.parse(uri))
    .setPackage(context.packageName)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
