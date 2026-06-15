package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/**
 * Réparation 1× des agrégats vitaux journaliers (dernier HC chronologique / jour).
 * N'envoie **aucun** sample synthétique — évite de polluer vitals/latest.
 * L'UI patient lit HC via [HealthConnectDisplayReader] + overlay JS.
 */
object VitalsResyncExecutor {

    private const val TAG = "VitalsDailyRepair"

    suspend fun maybeRun(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ): Boolean = withContext(Dispatchers.IO) {
        val patientId = store.resolvePatientId() ?: return@withContext false
        if (store.getVitalsResyncAt(patientId) > 0L) return@withContext false
        if (store.getFullBackfillAt(patientId) <= 0L) return@withContext false

        val now = System.currentTimeMillis()
        val start = now - TokenStore.FULL_LOOKBACK_MS
        val ctx = repository.beginCollectContext()
        val startInst = Instant.ofEpochMilli(start)
        val endInst = Instant.ofEpochMilli(now)
        val zone = ZoneId.systemDefault()

        val types = listOf(
            "restingHeartRate",
            "heartRateVariability",
            "respiratoryRate",
            "oxygenSaturation",
            "bodyTemperature",
        )
        val dailyByDay = mutableMapOf<LocalDate, DailyAggregate>()

        for (type in types) {
            val raw = repository.readSampleType(ctx, type, startInst, endInst)
            if (raw.isEmpty()) continue
            raw.groupBy { it.startAt.atZone(zone).toLocalDate() }.forEach { (day, samples) ->
                val dayLatest = VitalSanity.latestChronological(samples) ?: return@forEach
                val row = dailyByDay.getOrPut(day) { DailyAggregate(day) }
                when (type) {
                    "restingHeartRate" -> row.restingHeartRateAvg = dayLatest.value
                    "heartRateVariability" -> row.hrvAvgMs = dayLatest.value
                    "respiratoryRate" -> row.respiratoryRateAvg = dayLatest.value
                    "oxygenSaturation" -> row.oxygenSaturationAvg = dayLatest.value
                    "bodyTemperature" -> row.bodyTemperatureAvg = dayLatest.value
                }
            }
        }

        val rows = dailyByDay.values.filter { it.hasAnyValue() }.sortedBy { it.day }
        if (rows.isEmpty()) {
            Log.i(TAG, "VITALS_DAILY_REPAIR skip — aucun vital HC sur 60 j")
            return@withContext false
        }

        Log.i(TAG, "VITALS_DAILY_REPAIR début — ${rows.size} jour(s), samples=0")
        val payload = repository.buildPartialPayload(
            ctx,
            startInst,
            endInst,
            emptyMap(),
            emptyList(),
            rows,
        )
        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "vitals-daily-repair",
            includeDailyAggregates = true,
        )
        body.optJSONObject("fetch")?.put("strategy", "health_connect_vitals_daily_repair")

        when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setVitalsResyncAt(patientId, System.currentTimeMillis())
                val msg = "VITALS_DAILY_REPAIR ok — ${rows.size} jour(s), agg=${post.aggregatesInserted}"
                Log.i(TAG, msg)
                HealthBridge.logToJs(msg)
                true
            }
            else -> {
                Log.w(TAG, "VITALS_DAILY_REPAIR échec")
                false
            }
        }
    }
}
