package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/**
 * Réparation 1× j 8–90 : re-envoie vitaux compacts (horaire nocturne) pour rescoring
 * backend sur les comptes déjà syncés avec timestamps midi.
 */
object RecoveryRescoreExecutor {

    private const val TAG = "RecoveryRescoreRepair"

    private val REPAIR_TYPES = listOf(
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
    )

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

        val sleepRaw = repository.readSampleType(ctx, "sleep", startInst, endInst)
        val nightIndex = HistoricalLightCompactor.buildWakeDayNightTimestampIndex(
            sleepRaw,
            ctx.dailyByDay,
            zone,
            historicalLight = true,
        )

        val merged = linkedMapOf<String, List<SamplePoint>>()
        var totalSamples = 0
        for (type in REPAIR_TYPES) {
            val raw = repository.readSampleType(ctx, type, startInst, endInst)
            if (raw.isEmpty()) continue
            val collapsed = HistoricalLightCompactor.compactVitalsForDailyExtended(
                raw,
                type,
                zone,
                nightIndex,
            )
            if (collapsed.isEmpty()) continue
            merged[type] = collapsed
            totalSamples += collapsed.size
        }

        if (merged.isEmpty()) {
            Log.i(TAG, "RECOVERY_RESCORE_REPAIR skip — aucun vital compact j 8–90")
            return@withContext false
        }

        Log.i(
            TAG,
            "RECOVERY_RESCORE_REPAIR début — ${merged.size} type(s), $totalSamples sample(s)",
        )
        HealthBridge.logToJs(
            "[sync-session] RECOVERY_RESCORE_REPAIR début samples=$totalSamples",
        )

        val payload = repository.buildPartialPayload(
            ctx,
            startInst,
            endInst,
            merged,
            emptyList(),
            emptyList(),
        )
        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "recovery-rescore-repair",
            includeDailyAggregates = false,
        )
        body.optJSONObject("fetch")?.put("strategy", "healthkit_recovery_rescore_repair")

        when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setRecoveryRescoreRepairAt(patientId, now)
                Log.i(TAG, "RECOVERY_RESCORE_REPAIR ok samples=$totalSamples")
                HealthBridge.logToJs(
                    "[sync-session] RECOVERY_RESCORE_REPAIR ok samples=$totalSamples",
                )
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
