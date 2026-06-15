package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/**
 * Réparation 1× des steps_total manquants côté serveur — aligné iOS [maybeRepairHistoricalSteps].
 */
object StepsRepairExecutor {

    private const val TAG = "StepsRepair"

    suspend fun maybeRun(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ): Boolean = withContext(Dispatchers.IO) {
        val patientId = store.resolvePatientId() ?: return@withContext false
        if (store.getStepsRepairAt(patientId) > 0L) return@withContext false
        if (store.getFullBackfillAt(patientId) <= 0L) return@withContext false

        val gaps = ServerBackfillProbe.probeStepsGaps(store, http)
        if (gaps.missingCount <= 0) {
            store.setStepsRepairAt(patientId, System.currentTimeMillis())
            Log.i(TAG, "Aucun jour sans steps_total — réparation ignorée")
            return@withContext false
        }

        Log.i(
            TAG,
            "STEPS_REPAIR début — ${gaps.missingCount} jour(s) sans steps_total",
        )

        val now = System.currentTimeMillis()
        val start = now - TokenStore.DAILY_AGGREGATE_LOOKBACK_MS
        val payload = repository.collectStepsRepairOnly(start, now)
        if (payload.samplesByType["steps"].isNullOrEmpty()) {
            Log.i(TAG, "STEPS_REPAIR skip — aucun pas Health Connect sur 60 j")
            return@withContext false
        }

        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "steps-repair",
            includeDailyAggregates = true,
        )
        body.optJSONObject("fetch")?.put("strategy", "health_connect_steps_repair")

        when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setStepsRepairAt(patientId, System.currentTimeMillis())
                Log.i(
                    TAG,
                    "STEPS_REPAIR ok — inserts=${post.samplesInserted} agg=${post.aggregatesInserted}",
                )
                true
            }
            else -> {
                Log.w(TAG, "STEPS_REPAIR échec")
                false
            }
        }
    }
}
