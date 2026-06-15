package com.pcpinnov.pcpttherapy.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.round
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Lecture directe Health Connect pour aligner l'UI patient sur l'app HC. */
object HealthConnectDisplayReader {

    private val ISO = DateTimeFormatter.ISO_INSTANT

    suspend fun readSnapshot(context: Context): JSONObject = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        if (HealthConnectClient.getSdkStatus(app) != HealthConnectClient.SDK_AVAILABLE) {
            return@withContext JSONObject().put("error", "hc_unavailable")
        }
        if (HealthConnectAuthHelper.countGrantedSync(app) == 0) {
            return@withContext JSONObject().put("error", "no_permissions")
        }

        val client = HealthConnectClient.getOrCreate(app)
        val repository = HealthSyncRepository(app)
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val today = LocalDate.now(zone)
        val dayStart = today.atStartOfDay(zone).toInstant()
        val lookback = now.minusSeconds(7L * 24 * 60 * 60)

        val granted = client.permissionController.getGrantedPermissions()
        val todayObj = JSONObject().put("day", today.toString())

        if (HealthPermission.getReadPermission(StepsRecord::class) in granted) {
            aggregateDay(client, dayStart, now, listOf(StepsRecord.COUNT_TOTAL))?.let { result ->
                result[StepsRecord.COUNT_TOTAL]?.let { todayObj.put("steps_total", it) }
            }
        }
        if (HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class) in granted) {
            aggregateDay(client, dayStart, now, listOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL))
                ?.let { result ->
                    result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories?.let { kcal ->
                        todayObj.put("calories_total_kcal", round(kcal * 100.0) / 100.0)
                    }
                }
        }

        val ctx = repository.beginCollectContext()
        val sleepSamples = repository.readSampleType(ctx, "sleep", lookback, now)
        val lastNight = SleepNightAttribution.lastNightSleepMinutes(sleepSamples, zone, now)
        if (lastNight != null && lastNight > 0) {
            todayObj.put("sleep_total_min", lastNight)
        }

        val hrvSamples = repository.readSampleType(ctx, "heartRateVariability", lookback, now)
        VitalSanity.latestChronological(hrvSamples)?.let { s ->
            todayObj.put("hrv_avg_ms", s.value)
        }
        val rhrSamples = repository.readSampleType(ctx, "restingHeartRate", lookback, now)
        VitalSanity.latestChronological(rhrSamples)?.let { s ->
            todayObj.put("resting_heart_rate_avg", s.value)
        }
        val respSamples = repository.readSampleType(ctx, "respiratoryRate", lookback, now)
        VitalSanity.latestChronological(respSamples)?.let { s ->
            todayObj.put("respiratory_rate_avg", s.value)
        }
        val spo2Samples = repository.readSampleType(ctx, "oxygenSaturation", lookback, now)
        VitalSanity.latestChronological(spo2Samples)?.let { s ->
            todayObj.put("oxygen_saturation_avg", s.value)
        }
        val tempSamples = repository.readSampleType(ctx, "bodyTemperature", lookback, now)
        VitalSanity.latestChronological(tempSamples)?.let { s ->
            todayObj.put("body_temperature_avg", s.value)
        }

        val vitals = JSONObject()
        VitalSanity.latestChronological(hrvSamples)?.let { vitals.put("hrv", sampleToVitalJson(it)) }
        VitalSanity.latestChronological(rhrSamples)?.let { vitals.put("resting_heart_rate", sampleToVitalJson(it)) }
        VitalSanity.latestChronological(respSamples)?.let { vitals.put("respiratory_rate", sampleToVitalJson(it)) }
        VitalSanity.latestChronological(spo2Samples)?.let { vitals.put("oxygen_saturation", sampleToVitalJson(it)) }
        VitalSanity.latestChronological(tempSamples)?.let { vitals.put("body_temperature", sampleToVitalJson(it)) }

        JSONObject()
            .put("read_at_ms", System.currentTimeMillis())
            .put("zone", zone.id)
            .put("day", today.toString())
            .put("today", todayObj)
            .put("vitals", vitals)
    }

    private fun sampleToVitalJson(sample: SamplePoint): JSONObject =
        JSONObject()
            .put("data_type", sample.dataType)
            .put("value", sample.value.toString())
            .put("unit", sample.unit)
            .put("recorded_at", ISO.format(sample.startAt))
            .put("source_name", sample.sourceName ?: sample.sourceId ?: "health_connect")

    private suspend fun aggregateDay(
        client: HealthConnectClient,
        start: Instant,
        end: Instant,
        metrics: List<androidx.health.connect.client.aggregate.AggregateMetric<*>>,
    ): androidx.health.connect.client.aggregate.AggregationResult? {
        val zone = ZoneId.systemDefault()
        val startLocal = LocalDateTime.ofInstant(start, zone)
        val endLocal = LocalDateTime.ofInstant(end, zone)
        val buckets = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = metrics.toSet(),
                timeRangeFilter = TimeRangeFilter.between(startLocal, endLocal),
                timeRangeSlicer = Period.ofDays(1),
            ),
        )
        return buckets.firstOrNull()?.result
    }
}
