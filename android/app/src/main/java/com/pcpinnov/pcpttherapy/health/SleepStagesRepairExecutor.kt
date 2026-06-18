package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * Réparation ciblée des stades sommeil historiques (j 8–90) — aligné iOS V2.
 */
object SleepStagesRepairExecutor {

    private const val TAG = "SleepStagesRepair"
    private const val MAX_ATTEMPTS = 2
    private const val GAP_BATCH_DAYS = 14
    private val DAY_FMT: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

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
                "Couverture stades OK (${gaps.stagedNights}/${gaps.historicalSleepNights} nuits j 8–90)",
            )
            return@withContext false
        }

        val attempts = store.getSleepStagesRepairAttempts(patientId)
        if (attempts >= MAX_ATTEMPTS) {
            if (store.getSleepStagesRepairAt(patientId) <= 0L) {
                store.setSleepStagesRepairAt(patientId, System.currentTimeMillis())
            }
            Log.i(TAG, "SLEEP_STAGES_REPAIR skip (max $MAX_ATTEMPTS tentative(s))")
            HealthBridge.logToJs(
                "[sync-session] SLEEP_STAGES_REPAIR skip (max $MAX_ATTEMPTS tentative(s) — recovery non impacté)",
            )
            return@withContext false
        }

        if (store.getSleepStagesRepairAt(patientId) > 0L) {
            Log.i(TAG, "Reprise — gap stades sommeil persistant malgré tentative précédente")
        }

        store.setSleepStagesRepairAttempts(patientId, attempts + 1)

        val missing = gaps.missingWakeDays
        val gapNote = if (missing.isNotEmpty()) ", ${missing.size} nuit(s) ciblée(s)" else ""
        Log.i(
            TAG,
            "SLEEP_STAGES_REPAIR début — ${gaps.stagedNights}/${gaps.historicalSleepNights} nuit(s) avec stades sur j 8–90$gapNote",
        )
        HealthBridge.logToJs(
            "[sync-session] SLEEP_STAGES_REPAIR début staged=${gaps.stagedNights} sleep_nights=${gaps.historicalSleepNights} missing=${missing.size}",
        )

        val zone = ZoneId.systemDefault()
        var sentSamples = 0

        if (missing.isNotEmpty()) {
            val batches = missing.sorted().chunked(GAP_BATCH_DAYS)
            for (batch in batches) {
                val window = wakeDaysToReadWindow(batch) ?: continue
                val wakeDaySet = batch.toSet()
                val payload = repository.collectSleepStagesRepairOnly(window.first, window.second)
                val filtered = (payload.samplesByType["sleep"] ?: emptyList()).filter { sample ->
                    val wake = sample.endAt.atZone(zone).toLocalDate().format(DAY_FMT)
                    wakeDaySet.contains(wake)
                }
                if (filtered.isEmpty()) continue
                val filteredPayload = payload.copy(samplesByType = mapOf("sleep" to filtered))
                val body = HealthSyncPayloadBuilder.build(
                    payload = filteredPayload,
                    syncId = UUID.randomUUID(),
                    phaseLabel = "sleep-stages-repair-gap",
                    includeDailyAggregates = false,
                )
                body.optJSONObject("fetch")?.put("strategy", "health_connect_sleep_stages_repair_gap")
                when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
                    is HealthSyncExecutor.PostResult.Success -> sentSamples += post.samplesInserted
                    else -> {
                        Log.w(TAG, "SLEEP_STAGES_REPAIR échec (lot gap)")
                        HealthBridge.logToJs("[sync-session] SLEEP_STAGES_REPAIR échec")
                        return@withContext false
                    }
                }
            }
        } else {
            val now = System.currentTimeMillis()
            val start = now - TokenStore.SAMPLE_INTRADAY_LOOKBACK_MS
            val end = now - TokenStore.PRIORITY_LOOKBACK_MS
            if (start >= end) {
                Log.i(TAG, "SLEEP_STAGES_REPAIR skip — fenêtre historique vide")
                return@withContext false
            }
            val payload = repository.collectSleepStagesRepairOnly(start, end)
            if ((payload.samplesByType["sleep"] ?: emptyList()).isEmpty()) {
                Log.i(TAG, "SLEEP_STAGES_REPAIR skip — aucun sommeil Health Connect sur j 8–90")
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
                is HealthSyncExecutor.PostResult.Success -> sentSamples = post.samplesInserted
                else -> {
                    Log.w(TAG, "SLEEP_STAGES_REPAIR échec")
                    HealthBridge.logToJs("[sync-session] SLEEP_STAGES_REPAIR échec")
                    if (attempts + 1 >= MAX_ATTEMPTS) {
                        store.setSleepStagesRepairAt(patientId, System.currentTimeMillis())
                    }
                    return@withContext false
                }
            }
        }

        if (sentSamples > 0) {
            store.setSleepStagesRepairAt(patientId, System.currentTimeMillis())
            val msg = "SLEEP_STAGES_REPAIR ok — samples=$sentSamples"
            Log.i(TAG, msg)
            HealthBridge.logToJs("[sync-session] $msg")
            return@withContext true
        }

        store.setSleepStagesRepairAt(patientId, System.currentTimeMillis())
        HealthBridge.logToJs("[sync-session] SLEEP_STAGES_REPAIR skip (pas de sommeil HC sur les nuits ciblées)")
        false
    }

    private fun wakeDaysToReadWindow(wakeDays: List<String>): Pair<Long, Long>? {
        if (wakeDays.isEmpty()) return null
        val sorted = wakeDays.sorted()
        val minDay = LocalDate.parse(sorted.first(), DAY_FMT)
        val maxDay = LocalDate.parse(sorted.last(), DAY_FMT)
        val start = minDay.minusDays(1).atTime(12, 0).atZone(ZoneId.of("UTC")).toInstant()
        val end = maxDay.plusDays(1).atTime(14, 0).atZone(ZoneId.of("UTC")).toInstant()
        return start.toEpochMilli() to end.toEpochMilli()
    }
}
