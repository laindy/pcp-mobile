package com.pcpinnov.pcpttherapy.health

import org.json.JSONArray
import org.json.JSONObject
import java.time.format.DateTimeFormatter

/** Résumé JSON de la dernière lecture Health Connect — exposé au rapport testeur JS. */
object HealthConnectReadSummary {

    private val ISO = DateTimeFormatter.ISO_INSTANT

    private data class MetricSpec(val key: String, val label: String, val field: (DailyAggregate) -> Any?)

    private val METRICS = listOf(
        MetricSpec("steps", "Pas") { it.stepsTotal },
        MetricSpec("distance", "Distance") { it.distanceTotalM },
        MetricSpec("calories", "Calories") { it.caloriesTotalKcal },
        MetricSpec("sleep", "Sommeil") { it.sleepTotalMin },
        MetricSpec("hrv", "HRV") { it.hrvAvgMs },
        MetricSpec("restingHeartRate", "FC repos") { it.restingHeartRateAvg },
        MetricSpec("respiratoryRate", "Respiration") { it.respiratoryRateAvg },
        MetricSpec("oxygenSaturation", "SpO₂") { it.oxygenSaturationAvg },
        MetricSpec("bodyTemperature", "Température") { it.bodyTemperatureAvg },
    )

    fun build(payload: SyncPayload, mode: String, readAtMillis: Long): String {
        val dailyWithData = payload.dailyAggregates
            .filter { it.hasAnyValue() }
            .sortedByDescending { it.day }
        val dailyLog = dailyWithData.take(14)

        val dailyArr = JSONArray()
        dailyLog.forEach { row ->
            val item = JSONObject().put("day", row.day.toString())
            row.stepsTotal?.let { item.put("steps_total", it) }
            row.distanceTotalM?.let { item.put("distance_total_m", it) }
            row.caloriesTotalKcal?.let { item.put("calories_total_kcal", it) }
            row.sleepTotalMin?.let { item.put("sleep_total_min", it) }
            row.hrvAvgMs?.let { item.put("hrv_avg_ms", it) }
            row.restingHeartRateAvg?.let { item.put("resting_heart_rate_avg", it) }
            row.respiratoryRateAvg?.let { item.put("respiratory_rate_avg", it) }
            row.oxygenSaturationAvg?.let { item.put("oxygen_saturation_avg", it) }
            row.bodyTemperatureAvg?.let { item.put("body_temperature_avg", it) }
            dailyArr.put(item)
        }

        val latestMetrics = JSONArray()
        METRICS.forEach { spec ->
            val row = dailyWithData.firstOrNull { spec.field(it) != null } ?: return@forEach
            val value = spec.field(row) ?: return@forEach
            latestMetrics.put(
                JSONObject()
                    .put("metric", spec.key)
                    .put("label", spec.label)
                    .put("value", value)
                    .put("day", row.day.toString()),
            )
        }

        val sampleCounts = JSONObject()
        payload.samplesByType.forEach { (type, list) ->
            sampleCounts.put(type, list.size)
        }

        val latestSamples = JSONArray()
        payload.samplesByType.forEach { (type, list) ->
            if (list.isEmpty()) return@forEach
            val latest = list.maxByOrNull { it.startAt.toEpochMilli() } ?: return@forEach
            latestSamples.put(
                JSONObject()
                    .put("data_type", type)
                    .put("value", latest.value)
                    .put("unit", latest.unit)
                    .put("start_at", ISO.format(latest.startAt))
                    .put("source_id", latest.sourceId?.take(120))
                    .put("source_name", latest.sourceName?.take(120)),
            )
        }

        val latestWorkout = payload.workouts.maxByOrNull { it.startAt.toEpochMilli() }
        val workoutInfo = JSONObject()
            .put("count", payload.workouts.size)
        if (latestWorkout != null) {
            workoutInfo
                .put("latest_type", latestWorkout.workoutType)
                .put("latest_start_at", ISO.format(latestWorkout.startAt))
                .put("latest_source_id", latestWorkout.sourceId?.take(120))
        }

        val errorsObj = JSONObject()
        payload.errors.forEach { (k, v) -> errorsObj.put(k, v.take(300)) }

        return JSONObject()
            .put("read_at_ms", readAtMillis)
            .put("window_start", ISO.format(payload.windowStart))
            .put("window_end", ISO.format(payload.windowEnd))
            .put("mode", mode)
            .put("is_empty", payload.isEmpty())
            .put("total_samples", payload.totalSampleCount())
            .put("daily_days_with_data", dailyWithData.size)
            .put("granted_types", JSONArray(payload.grantedDataTypes))
            .put("denied_types", JSONArray(payload.deniedDataTypes))
            .put("errors", errorsObj)
            .put("sample_counts", sampleCounts)
            .put("daily_rows", dailyArr)
            .put("latest_metrics", latestMetrics)
            .put("latest_samples", latestSamples)
            .put("workouts", workoutInfo)
            .toString()
    }
}
