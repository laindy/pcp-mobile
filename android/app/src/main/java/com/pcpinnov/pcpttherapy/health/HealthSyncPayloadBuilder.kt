package com.pcpinnov.pcpttherapy.health

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** Construit l'enveloppe POST `/api/v1/patients/me/health/sync` (contrat v1). */
object HealthSyncPayloadBuilder {

    private val UNIT_DEFAULTS = mapOf(
        "steps" to "count",
        "calories" to "kilocalorie",
        "sleep" to "minute",
        "restingHeartRate" to "bpm",
        "heartRateVariability" to "millisecond",
        "respiratoryRate" to "bpm",
        "oxygenSaturation" to "percent",
        "bodyTemperature" to "celsius",
        "heartRate" to "bpm",
        "vo2Max" to "milliliterPerKilogramPerMinute",
    )

    fun build(
        payload: SyncPayload,
        syncId: UUID,
        phaseLabel: String,
        includeDailyAggregates: Boolean,
    ): JSONObject {
        val zone = ZoneId.systemDefault()
        val samplesByType = JSONObject()
        for ((type, samples) in payload.samplesByType) {
            if (samples.isEmpty()) continue
            val block = JSONObject()
            block.put("data_type", type)
            block.put("unit_default", UNIT_DEFAULTS[type] ?: samples.first().unit)
            val arr = JSONArray()
            for (sample in samples) {
                if (!ScoreRingDailyFilter.isPostableVitalSample(sample, zone)) continue
                arr.put(sampleToJson(sample))
            }
            if (arr.length() == 0) continue
            block.put("sample_count", arr.length())
            block.put("samples", arr)
            samplesByType.put(type, block)
        }

        val workoutsArr = JSONArray()
        for (workout in payload.workouts) {
            workoutsArr.put(workoutToJson(workout))
        }
        val workouts = JSONObject()
        workouts.put("workout_count", payload.workouts.size)
        workouts.put("items", workoutsArr)

        val aggregates = JSONArray()
        if (includeDailyAggregates) {
            for (row in ScoreRingDailyFilter.filterDailyAggregates(payload.dailyAggregates, zone)) {
                aggregates.put(dailyToJson(row))
            }
        }

        return JSONObject().apply {
            put("schema_version", 1)
            put("sync_id", syncId.toString())
            put("synced_at", Instant.now().toString())
            put(
                "client",
                JSONObject().apply {
                    put("app", "com.pcpinnov.pcpttherapy")
                    put("app_version", "1.0.0")
                    put("platform", "android")
                    put("plugin", "health-connect-native")
                    put("plugin_version", "1.0.0")
                    put("os_version", "Android ${Build.VERSION.RELEASE}")
                },
            )
            put("source", "health_connect")
            put(
                "window",
                JSONObject().apply {
                    put("start_date", payload.windowStart.toString())
                    put("end_date", payload.windowEnd.toString())
                },
            )
            put(
                "authorization",
                JSONObject().apply {
                    put("read_granted", JSONArray(payload.grantedDataTypes))
                    put("read_denied", JSONArray(payload.deniedDataTypes))
                },
            )
            put(
                "fetch",
                JSONObject().apply {
                    put("strategy", "aggregate_plus_raw")
                    put("partial", payload.errors.isNotEmpty())
                    put("errors", JSONObject(payload.errors))
                    put(
                        "limits",
                        JSONObject().apply {
                            put("phase", phaseLabel)
                        },
                    )
                },
            )
            put("samples_by_type", samplesByType)
            put("workouts", workouts)
            put("daily_aggregates", aggregates)
        }
    }

    private fun sampleToJson(sample: SamplePoint): JSONObject =
        JSONObject().apply {
            put("dataType", sample.dataType)
            put("value", sample.value)
            put("unit", sample.unit)
            put("startDate", sample.startAt.toString())
            put("endDate", sample.endAt.toString())
            sample.sourceId?.let { put("sourceId", it) }
            sample.sourceName?.let { put("sourceName", it) }
            put("platformId", sample.platformId)
            sample.stage?.let { put("stage", it) }
            sample.origin?.let { origin ->
                put("origin", origin)
                if (sample.dataType == "bodyTemperature") {
                    put("hkType", origin)
                }
            }
        }

    private fun workoutToJson(workout: WorkoutPoint): JSONObject =
        JSONObject().apply {
            put("workoutType", workout.workoutType)
            workout.duration?.let { put("duration", it) }
            workout.totalEnergyBurned?.let { put("totalEnergyBurned", it) }
            workout.totalDistance?.let { put("totalDistance", it) }
            put("startDate", workout.startAt.toString())
            put("endDate", workout.endAt.toString())
            workout.sourceId?.let { put("sourceId", it) }
            workout.sourceName?.let { put("sourceName", it) }
            put("platformId", workout.platformId)
        }

    private fun dailyToJson(row: DailyAggregate): JSONObject =
        JSONObject().apply {
            put("day", row.day.toString())
            row.stepsTotal?.let { put("steps_total", it) }
            row.distanceTotalM?.let { put("distance_total_m", it) }
            row.caloriesTotalKcal?.let { put("calories_total_kcal", it) }
            row.sleepTotalMin?.let { put("sleep_total_min", it) }
            row.restingHeartRateAvg?.let { put("resting_heart_rate_avg", it) }
            row.hrvAvgMs?.let { put("hrv_avg_ms", it) }
            row.respiratoryRateAvg?.let { put("respiratory_rate_avg", it) }
            row.oxygenSaturationAvg?.let { put("oxygen_saturation_avg", it) }
            row.bodyTemperatureAvg?.let { put("body_temperature_avg", it) }
        }
}
