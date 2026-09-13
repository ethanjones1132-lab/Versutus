package com.versutus.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Redraws every placed widget on a timer so "Today" becomes "Yesterday" without
 * the app being opened. No network constraint: this reads only app-private
 * storage and the clock, and a network requirement would make it doze forever.
 */
class WidgetRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    VersutusStatusWidget().updateAll(applicationContext)
    return Result.success()
  }
}

/** The one place the refresh interval and its unique name are decided. Pure, JVM-tested. */
object WidgetRefreshPolicy {
  private const val UNIQUE = "versutus-widget-refresh"
  private const val HOURS = 6L

  fun uniqueName(): String = UNIQUE
  fun intervalMinutes(): Long = HOURS * 60

  fun enqueue(context: Context) {
    val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(HOURS, TimeUnit.HOURS)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.NOT_REQUIRED).build())
      .build()
    WorkManager.getInstance(context)
      .enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.KEEP, request)
  }
}
