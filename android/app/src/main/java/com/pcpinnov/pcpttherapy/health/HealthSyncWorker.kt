package com.pcpinnov.pcpttherapy.health

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Worker périodique 6h — lecture HC en background (permission dédiée requise).
 * La sync manuelle (swipe) passe par [ForegroundHealthSync].
 */
class HealthSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val forceFull = inputData.getBoolean(INPUT_FORCE_FULL, false)
        return when (
            HealthSyncExecutor.run(
                applicationContext,
                foreground = false,
                forceFullLookback = forceFull,
            )
        ) {
            HealthSyncExecutor.Outcome.SUCCESS -> Result.success()
            HealthSyncExecutor.Outcome.RETRY -> Result.retry()
            HealthSyncExecutor.Outcome.TERMINAL -> Result.success()
        }
    }

    companion object {
        const val WORK_NAME_PERIODIC = "pcp_health_sync_periodic"
        const val WORK_NAME_ONESHOT = "pcp_health_sync_oneshot"
        const val INPUT_FORCE_FULL = "force_full_lookback"
    }
}
