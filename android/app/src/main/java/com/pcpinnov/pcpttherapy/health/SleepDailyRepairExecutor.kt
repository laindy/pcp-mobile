package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.UUID

/**
 * Réparation 1× des agrégats sleep_total_min (jour de réveil, stades endormis).
 * Corrige les totaux serveur issus de la somme calendaire des segments bruts.
 */
object SleepDailyRepairExecutor {

    private const val TAG = "SleepDailyRepair"

    suspend fun maybeRun(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ): Boolean = withContext(Dispatchers.IO) {
        val patientId = store.resolvePatientId() ?: return@withContext false
        if (store.getSleepDailyRepairAt(patientId) > 0L) return@withContext false
        if (store.getFullBackfillAt(patientId) <= 0L) return@withContext false

        val now = System.currentTimeMillis()
        val start = now - TokenStore.DAILY_AGGREGATE_LOOKBACK_MS
        val payload = repository.collectSleepDailyRepair(start, now)
        if (payload.dailyAggregates.isEmpty()) {
            Log.i(TAG, "SLEEP_DAILY_REPAIR skip — aucun sommeil HC sur 60 j")
            return@withContext false
        }

        Log.i(TAG, "SLEEP_DAILY_REPAIR début — ${payload.dailyAggregates.size} jour(s)")
        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "sleep-daily-repair",
            includeDailyAggregates = true,
        )
        body.optJSONObject("fetch")?.put("strategy", "health_connect_sleep_daily_repair")

        when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setSleepDailyRepairAt(patientId, System.currentTimeMillis())
                val msg = "SLEEP_DAILY_REPAIR ok — ${payload.dailyAggregates.size} jour(s), agg=${post.aggregatesInserted}"
                Log.i(TAG, msg)
                HealthBridge.logToJs(msg)
                true
            }
            else -> {
                Log.w(TAG, "SLEEP_DAILY_REPAIR échec")
                false
            }
        }
    }
}
