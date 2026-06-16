package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/**
 * Réparation 1× recovery j 8–90 : re-envoie HRV compact (1/jour) pour forcer le
 * rescoring backend sur les jours déjà syncés avant inversion daily-extended → historical.
 */
object RecoveryRescoreExecutor {

    private const val TAG = "RecoveryRescoreRepair"

    suspend fun maybeRun(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ): Boolean = withContext(Dispatchers.IO) {
        val patientId = store.resolvePatientId() ?: return@withContext false
        if (store.getRecoveryRescoreRepairAt(patientId) > 0L) return@withContext false
        if (store.getFullBackfillAt(patientId) <= 0L) return@withContext false

        val now = System.currentTimeMillis()
        val end = now - TokenStore.PRIORITY_LOOKBACK_MS
        val start = now - TokenStore.SAMPLE_INTRADAY_LOOKBACK_MS
        if (start >= end) {
            store.setRecoveryRescoreRepairAt(patientId, now)
            return@withContext false
        }

        val ctx = repository.beginCollectContext()
        val startInst = Instant.ofEpochMilli(start)
        val endInst = Instant.ofEpochMilli(end)
        val zone = ZoneId.systemDefault()

        val raw = repository.readSampleType(ctx, "heartRateVariability", startInst, endInst)
        if (raw.isEmpty()) {
            Log.i(TAG, "RECOVERY_RESCORE_REPAIR skip — aucun HRV HC j 8–90")
            return@withContext false
        }

        val collapsed = HistoricalLightCompactor.compactVitalsForDailyExtended(
            raw,
            "heartRateVariability",
            zone,
        )
        if (collapsed.isEmpty()) {
            Log.i(TAG, "RECOVERY_RESCORE_REPAIR skip — HRV compact vide")
            return@withContext false
        }

        Log.i(
            TAG,
            "RECOVERY_RESCORE_REPAIR début — HRV ${raw.size} bruts → ${collapsed.size} jour(s)",
        )
        HealthBridge.logToJs(
            "[sync-session] RECOVERY_RESCORE_REPAIR début samples=${collapsed.size}",
        )

        val payload = repository.buildPartialPayload(
            ctx,
            startInst,
            endInst,
            mapOf("heartRateVariability" to collapsed),
            emptyList(),
            emptyList(),
        )
        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "recovery-rescore-repair",
            includeDailyAggregates = false,
        )
        body.optJSONObject("fetch")?.put("strategy", "health_connect_recovery_rescore_repair")

        return@withContext when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setRecoveryRescoreRepairAt(patientId, System.currentTimeMillis())
                val msg =
                    "RECOVERY_RESCORE_REPAIR ok — ${collapsed.size} jour(s), ins=${post.samplesInserted}"
                Log.i(TAG, msg)
                HealthBridge.logToJs("[sync-session] $msg")
                true
            }
            else -> {
                Log.w(TAG, "RECOVERY_RESCORE_REPAIR échec")
                HealthBridge.logToJs("[sync-session] RECOVERY_RESCORE_REPAIR échec")
                false
            }
        }
    }
}
