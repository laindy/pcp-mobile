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
 * Réparation 1× j 8–90 : re-envoie vitaux compacts (horaire nocturne) par tranches
 * pour rescoring recovery backend une fois daily-extended terminé.
 */
object RecoveryRescoreExecutor {

    private const val TAG = "RecoveryRescoreRepair"
    private const val SLICE_MS = 21L * 24L * 60L * 60L * 1000L

    private val REPAIR_TYPES = listOf(
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
        "restingHeartRate",
    )

    private data class Slice(val startMs: Long, val endMs: Long)

    private fun buildSlices(now: Long): List<Slice> {
        val end = now - TokenStore.PRIORITY_LOOKBACK_MS
        val start = now - TokenStore.SAMPLE_INTRADAY_LOOKBACK_MS
        if (start >= end) return emptyList()
        val out = mutableListOf<Slice>()
        var sliceEnd = end
        while (sliceEnd > start) {
            val sliceStart = maxOf(start, sliceEnd - SLICE_MS)
            out += Slice(sliceStart, sliceEnd)
            sliceEnd = sliceStart
        }
        return out
    }

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
        val slices = buildSlices(now)
        if (slices.isEmpty()) {
            store.setRecoveryRescoreRepairAt(patientId, now)
            return@withContext false
        }

        val zone = ZoneId.systemDefault()
        var totalSamples = 0
        Log.i(TAG, "RECOVERY_RESCORE_REPAIR début — ${slices.size} tranche(s)")
        HealthBridge.logToJs("[sync-session] RECOVERY_RESCORE_REPAIR début slices=${slices.size}")

        for ((idx, slice) in slices.withIndex()) {
            val sliceNum = idx + 1
            val startInst = Instant.ofEpochMilli(slice.startMs)
            val endInst = Instant.ofEpochMilli(slice.endMs)
            val ctx = repository.beginCollectContext()

            val sleepRaw = repository.readSampleType(ctx, "sleep", startInst, endInst)
            val nightIndex = HistoricalLightCompactor.buildWakeDayNightTimestampIndex(
                sleepRaw,
                ctx.dailyByDay,
                zone,
                phaseLabel = "historical",
            )

            val merged = linkedMapOf<String, List<SamplePoint>>()
            var sliceSamples = 0
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
                sliceSamples += collapsed.size
            }

            if (merged.isEmpty()) {
                Log.i(TAG, "RECOVERY_RESCORE_REPAIR tranche $sliceNum/${slices.size} — aucun vital")
                continue
            }

            val wakeDays = merged.values.flatten()
                .map { HistoricalLightCompactor.vitalWakeDayFromInstant(it.startAt, zone) }
                .toSet()
            val companions = HistoricalLightCompactor.buildCompanionSleepForWakeDays(
                wakeDays,
                sleepRaw,
                zone,
            )
            if (companions.isNotEmpty()) {
                merged["sleep"] = companions
                sliceSamples += companions.size
                Log.i(
                    TAG,
                    "RECOVERY_RESCORE_REPAIR tranche $sliceNum/${slices.size} — ${companions.size} sommeil compagnon",
                )
            }

            Log.i(TAG, "RECOVERY_RESCORE_REPAIR tranche $sliceNum/${slices.size} — $sliceSamples sample(s)")
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
                    totalSamples += sliceSamples
                }
                else -> {
                    Log.w(TAG, "RECOVERY_RESCORE_REPAIR échec tranche $sliceNum/${slices.size}")
                    HealthBridge.logToJs(
                        "[sync-session] RECOVERY_RESCORE_REPAIR échec tranche $sliceNum/${slices.size}",
                    )
                    return@withContext false
                }
            }
        }

        if (totalSamples <= 0) {
            Log.i(TAG, "RECOVERY_RESCORE_REPAIR skip — aucun vital compact j 8–90")
            return@withContext false
        }

        store.setRecoveryRescoreRepairAt(patientId, now)
        Log.i(TAG, "RECOVERY_RESCORE_REPAIR ok samples=$totalSamples slices=${slices.size}")
        HealthBridge.logToJs(
            "[sync-session] RECOVERY_RESCORE_REPAIR ok samples=$totalSamples slices=${slices.size}",
        )
        true
    }
}
