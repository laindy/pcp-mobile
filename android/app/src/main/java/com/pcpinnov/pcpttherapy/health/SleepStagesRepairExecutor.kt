package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.UUID

/**
 * Réparation ciblée des stades sommeil historiques (j 8–60) — aligné iOS
 * [maybeRepairHistoricalSleepStages] + probe [ServerBackfillProbe.probeSleepStagesGaps].
 */
object SleepStagesRepairExecutor {

    private const val TAG = "SleepStagesRepair"

    suspend fun maybeRun(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ): Boolean = withContext(Dispatchers.IO) {
        val patientId = store.resolvePatientId() ?: return@withContext false

        val gaps = ServerBackfillProbe.probeSleepStagesGaps(store, http)
        if (!gaps.needsRepair) {
            if (store.getSleepStagesRepairAt(patientId) <= 0L) {
                store.setSleepStagesRepairAt(patientId, System.currentTimeMillis())
            }
            Log.i(
                TAG,
                "Couverture stades OK (${gaps.stagedNights}/${gaps.historicalSleepNights} nuits j 8–60)",
            )
            return@withContext false
        }

        if (store.getSleepStagesRepairAt(patientId) > 0L) {
            Log.i(TAG, "Reprise — gap stades sommeil persistant malgré tentative précédente")
        }

        Log.i(
            TAG,
            "SLEEP_STAGES_REPAIR début — ${gaps.stagedNights}/${gaps.historicalSleepNights} nuit(s) avec stades sur j 8–60",
        )
        HealthBridge.logToJs(
            "[sync-session] SLEEP_STAGES_REPAIR début staged=${gaps.stagedNights} sleep_nights=${gaps.historicalSleepNights}",
        )

        val now = System.currentTimeMillis()
        val start = now - TokenStore.SAMPLE_INTRADAY_LOOKBACK_MS
        val end = now - TokenStore.PRIORITY_LOOKBACK_MS
        if (start >= end) {
            Log.i(TAG, "SLEEP_STAGES_REPAIR skip — fenêtre historique vide")
            return@withContext false
        }

        val payload = repository.collectSleepStagesRepairOnly(start, end)
        val sleepSamples = payload.samplesByType["sleep"].orEmpty()
        if (sleepSamples.isEmpty()) {
            Log.i(TAG, "SLEEP_STAGES_REPAIR skip — aucun sommeil Health Connect sur j 8–60")
            HealthBridge.logToJs("[sync-session] SLEEP_STAGES_REPAIR skip (pas de sommeil HC)")
            return@withContext false
        }

        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "sleep-stages-repair",
            includeDailyAggregates = false,
        )
        body.optJSONObject("fetch")?.put("strategy", "health_connect_sleep_stages_repair")

        when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setSleepStagesRepairAt(patientId, System.currentTimeMillis())
                val msg =
                    "SLEEP_STAGES_REPAIR ok — samples=${post.samplesInserted} agg=${post.aggregatesInserted}"
                Log.i(TAG, msg)
                HealthBridge.logToJs("[sync-session] $msg")
                true
            }
            else -> {
                Log.w(TAG, "SLEEP_STAGES_REPAIR échec")
                HealthBridge.logToJs("[sync-session] SLEEP_STAGES_REPAIR échec")
                false
            }
        }
    }
}
