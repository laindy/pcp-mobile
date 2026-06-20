package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.util.Locale
import kotlin.math.roundToInt
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/**
 * Lecture Health Connect — agrégats journaliers + samples bruts + workouts.
 * Aligné sur les types demandés côté iOS / capgo.
 */
class HealthSyncRepository(private val context: Context) {

    private val tag = "HealthSyncRepo"
    private val client: HealthConnectClient by lazy { HealthConnectClient.getOrCreate(context) }
    private val zone: ZoneId = ZoneId.systemDefault()

    /** Évite LocalDateTime/LocalDate.ofInstant — absent sur Android API 26–32 sans desugaring. */
    private fun instantToLocalDateTime(instant: Instant): LocalDateTime {
        val offset = zone.rules.getOffset(instant)
        return LocalDateTime.ofEpochSecond(instant.epochSecond, instant.nano, offset)
    }

    private fun instantToLocalDate(instant: Instant): LocalDate =
        instantToLocalDateTime(instant).toLocalDate()

    /** Réparation steps — agrégats journaliers + samples scoring steps uniquement. */
    suspend fun collectStepsRepairOnly(startMillis: Long, endMillis: Long): SyncPayload {
        val start = Instant.ofEpochMilli(startMillis)
        val end = Instant.ofEpochMilli(endMillis)
        val dailyByDay = mutableMapOf<LocalDate, DailyAggregate>()
        val samplesByType = mutableMapOf<String, MutableList<SamplePoint>>()
        val errors = mutableMapOf<String, String>()
        val granted = client.permissionController.getGrantedPermissions()
        val grantedDataTypes = mutableSetOf<String>()
        val deniedDataTypes = mutableSetOf<String>()

        runRead("steps", HealthPermission.getReadPermission(StepsRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            aggregateBuckets(start, end, listOf(StepsRecord.COUNT_TOTAL)).forEach { (day, result) ->
                result[StepsRecord.COUNT_TOTAL]?.let { daily(day, dailyByDay).stepsTotal = it }
            }
            fillStepsFromRecords(start, end, dailyByDay)
        }

        for (row in dailyByDay.values) {
            val steps = row.stepsTotal ?: continue
            if (steps <= 0L) continue
            val noon = row.day.atTime(12, 0).atZone(zone).toInstant()
            addSample(
                samplesByType,
                SamplePoint(
                    dataType = "steps",
                    value = steps.toDouble(),
                    unit = "count",
                    startAt = noon,
                    endAt = noon,
                    sourceId = "health_connect",
                    sourceName = "health_connect",
                    platformId = "steps|agg|${row.day}",
                ),
            )
        }

        return SyncPayload(
            windowStart = start,
            windowEnd = end,
            grantedDataTypes = grantedDataTypes.toList(),
            deniedDataTypes = deniedDataTypes.toList(),
            errors = errors,
            samplesByType = samplesByType,
            dailyAggregates = dailyByDay.values.filter { (it.stepsTotal ?: 0L) > 0L }.sortedBy { it.day },
            workouts = emptyList(),
        )
    }

    /** Réparation énergie/effort — agrégats + samples scoring pas/cal sur fenêtre récente. */
    suspend fun collectActivityCaloriesRepairOnly(startMillis: Long, endMillis: Long): SyncPayload {
        val start = Instant.ofEpochMilli(startMillis)
        val end = Instant.ofEpochMilli(endMillis)
        val dailyByDay = mutableMapOf<LocalDate, DailyAggregate>()
        val samplesByType = mutableMapOf<String, MutableList<SamplePoint>>()
        val errors = mutableMapOf<String, String>()
        val granted = client.permissionController.getGrantedPermissions()
        val grantedDataTypes = mutableSetOf<String>()
        val deniedDataTypes = mutableSetOf<String>()

        runRead("steps", HealthPermission.getReadPermission(StepsRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            aggregateBuckets(start, end, listOf(StepsRecord.COUNT_TOTAL)).forEach { (day, result) ->
                result[StepsRecord.COUNT_TOTAL]?.let { daily(day, dailyByDay).stepsTotal = it }
            }
            fillStepsFromRecords(start, end, dailyByDay)
        }
        runRead("calories", HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            aggregateBuckets(start, end, listOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)).forEach { (day, result) ->
                result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories?.let {
                    daily(day, dailyByDay).caloriesTotalKcal = it
                }
            }
            fillCaloriesFromRecords(start, end, dailyByDay)
        }

        for ((type, samples) in buildScoringSamples(dailyByDay)) {
            if (samples.isEmpty()) continue
            samplesByType[type] = samples.toMutableList()
        }

        val activityRows = dailyByDay.values.filter {
            (it.stepsTotal ?: 0L) > 0L ||
                (it.caloriesTotalKcal ?: 0.0) > 0.0 ||
                (it.restingHeartRateAvg ?: 0.0) > 0.0
        }.sortedBy { it.day }

        return SyncPayload(
            windowStart = start,
            windowEnd = end,
            grantedDataTypes = grantedDataTypes.toList(),
            deniedDataTypes = deniedDataTypes.toList(),
            errors = errors,
            samplesByType = samplesByType,
            dailyAggregates = activityRows,
            workouts = emptyList(),
        )
    }

    suspend fun collect(startMillis: Long, endMillis: Long, phaseLabel: String = "sync"): SyncPayload {
        val granted = client.permissionController.getGrantedPermissions()
        Log.i(tag, "Permissions HC accordées : ${granted.size}")

        val start = Instant.ofEpochMilli(startMillis)
        val end = Instant.ofEpochMilli(endMillis)
        val dailyByDay = mutableMapOf<LocalDate, DailyAggregate>()
        val samplesByType = mutableMapOf<String, MutableList<SamplePoint>>()
        val workouts = mutableListOf<WorkoutPoint>()
        val errors = mutableMapOf<String, String>()
        val grantedDataTypes = mutableSetOf<String>()
        val deniedDataTypes = mutableSetOf<String>()

        // ── Agrégats journaliers HC (mêmes totaux que l'app Health Connect) ──
        runRead("steps", HealthPermission.getReadPermission(StepsRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            aggregateBuckets(start, end, listOf(StepsRecord.COUNT_TOTAL)).forEach { (day, result) ->
                result[StepsRecord.COUNT_TOTAL]?.let { daily(day, dailyByDay).stepsTotal = it }
            }
            fillStepsFromRecords(start, end, dailyByDay)
        }
        runRead("calories", HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            aggregateBuckets(start, end, listOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)).forEach { (day, result) ->
                result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories?.let {
                    daily(day, dailyByDay).caloriesTotalKcal = it
                }
            }
            fillCaloriesFromRecords(start, end, dailyByDay)
        }
        // Sommeil : pas d'agrégat calendaire HC (double les nuits) — wake-day via applyWakeDayTotals.
        // ── Samples bruts (vitaux + sommeil — pas FC continue) ──
        runRead("restingHeartRate", HealthPermission.getReadPermission(RestingHeartRateRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<RestingHeartRateRecord>(start, end).forEach { record ->
                addSample(samplesByType, SamplePoint(
                    dataType = "restingHeartRate",
                    value = record.beatsPerMinute.toDouble(),
                    unit = "bpm",
                    startAt = record.time,
                    endAt = record.time,
                    sourceId = record.metadata.dataOrigin.packageName,
                    sourceName = record.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("restingHeartRate", record.metadata, record.time.toEpochMilli(), record.beatsPerMinute.toDouble()),
                ))
            }
        }
        runRead("heartRateVariability", HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<HeartRateVariabilityRmssdRecord>(start, end).forEach { record ->
                addSample(samplesByType, SamplePoint(
                    dataType = "heartRateVariability",
                    value = record.heartRateVariabilityMillis,
                    unit = "millisecond",
                    startAt = record.time,
                    endAt = record.time,
                    sourceId = record.metadata.dataOrigin.packageName,
                    sourceName = record.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("heartRateVariability", record.metadata, record.time.toEpochMilli(), record.heartRateVariabilityMillis),
                ))
            }
        }
        runRead("respiratoryRate", HealthPermission.getReadPermission(RespiratoryRateRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<RespiratoryRateRecord>(start, end).forEach { record ->
                addSample(samplesByType, SamplePoint(
                    dataType = "respiratoryRate",
                    value = record.rate,
                    unit = "bpm",
                    startAt = record.time,
                    endAt = record.time,
                    sourceId = record.metadata.dataOrigin.packageName,
                    sourceName = record.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("respiratoryRate", record.metadata, record.time.toEpochMilli(), record.rate),
                ))
            }
        }
        runRead("oxygenSaturation", HealthPermission.getReadPermission(OxygenSaturationRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<OxygenSaturationRecord>(start, end).forEach { record ->
                val pct = if (record.percentage.value in 0.0..1.0) record.percentage.value * 100.0 else record.percentage.value
                addSample(samplesByType, SamplePoint(
                    dataType = "oxygenSaturation",
                    value = pct,
                    unit = "percent",
                    startAt = record.time,
                    endAt = record.time,
                    sourceId = record.metadata.dataOrigin.packageName,
                    sourceName = record.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("oxygenSaturation", record.metadata, record.time.toEpochMilli(), pct),
                ))
            }
        }
        runRead("bodyTemperature", HealthPermission.getReadPermission(BodyTemperatureRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<BodyTemperatureRecord>(start, end).forEach { record ->
                addSample(samplesByType, SamplePoint(
                    dataType = "bodyTemperature",
                    value = record.temperature.inCelsius,
                    unit = "celsius",
                    startAt = record.time,
                    endAt = record.time,
                    sourceId = record.metadata.dataOrigin.packageName,
                    sourceName = record.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("bodyTemperature", record.metadata, record.time.toEpochMilli(), record.temperature.inCelsius),
                    origin = ORIGIN_BODY_TEMPERATURE,
                ))
            }
        }
        readSkinTemperatureSamples(start, end, granted, grantedDataTypes, deniedDataTypes, errors, samplesByType)
        runRead("vo2Max", HealthPermission.getReadPermission(Vo2MaxRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<Vo2MaxRecord>(start, end).forEach { record ->
                addSample(samplesByType, SamplePoint(
                    dataType = "vo2Max",
                    value = record.vo2MillilitersPerMinuteKilogram,
                    unit = "milliliterPerKilogramPerMinute",
                    startAt = record.time,
                    endAt = record.time,
                    sourceId = record.metadata.dataOrigin.packageName,
                    sourceName = record.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("vo2Max", record.metadata, record.time.toEpochMilli(), record.vo2MillilitersPerMinuteKilogram),
                    origin = ORIGIN_VO2_MAX,
                ))
            }
        }
        // ── Sommeil : 1 segment de stade = 1 sample (contrat v1) ──
        runRead("sleep", HealthPermission.getReadPermission(SleepSessionRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<SleepSessionRecord>(start, end).forEach { session ->
                addSleepSessionSamples(session, samplesByType)
            }
        }
        runRead("workouts", HealthPermission.getReadPermission(ExerciseSessionRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            readRecords<ExerciseSessionRecord>(start, end).forEach { session ->
                val durationSec = (session.endTime.epochSecond - session.startTime.epochSecond).coerceAtLeast(0)
                val typeName = ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP[session.exerciseType]
                    ?.lowercase(Locale.ROOT)
                    ?: "other_workout"
                workouts += WorkoutPoint(
                    workoutType = typeName,
                    duration = durationSec.toInt(),
                    totalEnergyBurned = null,
                    totalDistance = null,
                    startAt = session.startTime,
                    endAt = session.endTime,
                    sourceId = session.metadata.dataOrigin.packageName,
                    sourceName = session.metadata.dataOrigin.packageName,
                    platformId = makePlatformId("workout", session.metadata, session.startTime.toEpochMilli(), durationSec.toDouble()),
                )
            }
        }

        // FC uniquement pendant les séances (TRIMP backend) — pas de FC continue 24/7.
        runRead("heartRate", HealthPermission.getReadPermission(HeartRateRecord::class), granted, grantedDataTypes, deniedDataTypes, errors) {
            var hrSamples = 0
            for (workout in workouts) {
                readRecords<HeartRateRecord>(workout.startAt, workout.endAt).forEach { record ->
                    record.samples.forEach { sample ->
                        hrSamples += 1
                        addSample(samplesByType, SamplePoint(
                            dataType = "heartRate",
                            value = sample.beatsPerMinute.toDouble(),
                            unit = "bpm",
                            startAt = sample.time,
                            endAt = sample.time,
                            sourceId = record.metadata.dataOrigin.packageName,
                            sourceName = record.metadata.dataOrigin.packageName,
                            platformId = makePlatformId("heartRate", record.metadata, sample.time.toEpochMilli(), sample.beatsPerMinute.toDouble()),
                        ))
                    }
                }
            }
            if (hrSamples > 0) {
                Log.i(tag, "FC workout: $hrSamples sample(s) sur ${workouts.size} séance(s)")
            }
        }

        injectDailyScoringSamples(dailyByDay.values, samplesByType)
        rollupDailyLatestVitals(samplesByType, dailyByDay)
        SleepNightAttribution.applyWakeDayTotals(
            dailyByDay,
            samplesByType["sleep"] ?: emptyList(),
            zone,
        )
        HistoricalLightCompactor.apply(samplesByType, dailyByDay, phaseLabel, zone)
        trimAndDedupeSamples(samplesByType)
        logSleepStageCollectSummary(samplesByType["sleep"] ?: emptyList())
        logVo2AndTemperatureSummary(samplesByType)

        val daysWithSteps = dailyByDay.count { it.value.stepsTotal != null && it.value.stepsTotal!! > 0 }
        Log.i(
            tag,
            "Collect terminé : ${dailyByDay.size} jour(s), $daysWithSteps avec pas, " +
                "${samplesByType.values.sumOf { it.size }} samples, ${workouts.size} workouts, " +
                "refusés=${deniedDataTypes.size}, erreurs=${errors.size}",
        )

        return SyncPayload(
            windowStart = start,
            windowEnd = end,
            grantedDataTypes = grantedDataTypes.toList(),
            deniedDataTypes = deniedDataTypes.toList(),
            errors = errors,
            samplesByType = samplesByType,
            dailyAggregates = ScoreRingDailyFilter.filterDailyAggregates(dailyByDay.values).sortedBy { it.day },
            workouts = workouts,
        )
    }

    private fun daily(day: LocalDate, map: MutableMap<LocalDate, DailyAggregate>): DailyAggregate =
        map.getOrPut(day) { DailyAggregate(day) }

    private suspend inline fun <reified T : Record> readRecords(start: Instant, end: Instant): List<T> {
        val out = mutableListOf<T>()
        var pageToken: String? = null
        var pages = 0
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = T::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end),
                    pageSize = PAGE_SIZE,
                    pageToken = pageToken,
                )
            )
            out += response.records
            pageToken = response.pageToken
            pages += 1
        } while (!pageToken.isNullOrBlank() && pages < MAX_PAGES)
        return out
    }

    /** Repli si aggregateGroupByPeriod ne remonte pas les données (ex. Google Fit → HC). */
    private suspend fun fillStepsFromRecords(
        start: Instant,
        end: Instant,
        dailyByDay: MutableMap<LocalDate, DailyAggregate>,
    ) {
        val sums = mutableMapOf<LocalDate, Long>()
        readRecords<StepsRecord>(start, end).forEach { record ->
            val day = instantToLocalDate(record.startTime)
            sums[day] = (sums[day] ?: 0L) + record.count
        }
        if (sums.isEmpty()) return
        Log.i(tag, "Steps fallback records : ${sums.size} jour(s)")
        sums.forEach { (day, total) ->
            val row = daily(day, dailyByDay)
            if (row.stepsTotal == null || row.stepsTotal == 0L) {
                row.stepsTotal = total
            }
        }
    }

    private suspend fun fillCaloriesFromRecords(
        start: Instant,
        end: Instant,
        dailyByDay: MutableMap<LocalDate, DailyAggregate>,
    ) {
        val sums = mutableMapOf<LocalDate, Double>()
        readRecords<ActiveCaloriesBurnedRecord>(start, end).forEach { record ->
            val day = instantToLocalDate(record.startTime)
            sums[day] = (sums[day] ?: 0.0) + record.energy.inKilocalories
        }
        if (sums.isEmpty()) return
        Log.i(tag, "Calories fallback records : ${sums.size} jour(s)")
        sums.forEach { (day, total) ->
            val row = daily(day, dailyByDay)
            if (row.caloriesTotalKcal == null || row.caloriesTotalKcal == 0.0) {
                row.caloriesTotalKcal = total
            }
        }
    }

    private suspend fun aggregateBuckets(
        start: Instant,
        end: Instant,
        metrics: List<androidx.health.connect.client.aggregate.AggregateMetric<*>>,
    ): Map<LocalDate, androidx.health.connect.client.aggregate.AggregationResult> {
        val startLocal = instantToLocalDateTime(start)
        val endLocal = instantToLocalDateTime(end)
        val buckets = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = metrics.toSet(),
                timeRangeFilter = TimeRangeFilter.between(startLocal, endLocal),
                timeRangeSlicer = Period.ofDays(1),
            )
        )
        return buckets.associate { it.startTime.toLocalDate() to it.result }
    }

    /** Raw HC stage int → contract string (backend maps stage_type_* → buckets). */
    private fun sleepStageTypeName(stageType: Int): String = when (stageType) {
        SleepSessionRecord.STAGE_TYPE_AWAKE -> "stage_type_awake"
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "stage_type_awake_in_bed"
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "stage_type_out_of_bed"
        SleepSessionRecord.STAGE_TYPE_LIGHT -> "stage_type_light"
        SleepSessionRecord.STAGE_TYPE_DEEP -> "stage_type_deep"
        SleepSessionRecord.STAGE_TYPE_REM -> "stage_type_rem"
        SleepSessionRecord.STAGE_TYPE_SLEEPING -> "stage_type_sleeping"
        SleepSessionRecord.STAGE_TYPE_UNKNOWN -> "stage_type_unknown"
        else -> "stage_type_unknown"
    }

    private fun addSleepSessionSamples(
        session: SleepSessionRecord,
        samplesByType: MutableMap<String, MutableList<SamplePoint>>,
    ) {
        val sourceId = session.metadata.dataOrigin.packageName
        val sourceName = session.metadata.dataOrigin.packageName
        val stages = session.stages
        if (!stages.isNullOrEmpty()) {
            stages.forEachIndexed { idx, stage ->
                val ms = stage.endTime.toEpochMilli() - stage.startTime.toEpochMilli()
                if (ms <= 0) return@forEachIndexed
                val mins = ms / 60000.0
                val stageName = sleepStageTypeName(stage.stage)
                val basePid = makePlatformId(
                    "sleep",
                    session.metadata,
                    stage.startTime.toEpochMilli(),
                    mins,
                )
                val platformId = "$basePid|$stageName|$idx".take(255)
                addSample(
                    samplesByType,
                    SamplePoint(
                        dataType = "sleep",
                        value = mins,
                        unit = "minute",
                        startAt = stage.startTime,
                        endAt = stage.endTime,
                        sourceId = sourceId,
                        sourceName = sourceName,
                        platformId = platformId,
                        stage = stageName,
                    ),
                )
            }
            return
        }
        val totalMs = session.endTime.toEpochMilli() - session.startTime.toEpochMilli()
        if (totalMs <= 0) return
        val mins = totalMs / 60000.0
        addSample(
            samplesByType,
            SamplePoint(
                dataType = "sleep",
                value = mins,
                unit = "minute",
                startAt = session.startTime,
                endAt = session.endTime,
                sourceId = sourceId,
                sourceName = sourceName,
                platformId = makePlatformId("sleep", session.metadata, session.endTime.toEpochMilli(), mins),
            ),
        )
    }

    /** Dernière mesure HC du jour (parité écran Health Connect), pas une moyenne. */
    private fun rollupDailyLatestVitals(
        samplesByType: Map<String, List<SamplePoint>>,
        dailyByDay: MutableMap<LocalDate, DailyAggregate>,
    ) {
        val latestFields = mapOf(
            "restingHeartRate" to { row: DailyAggregate, v: Double -> row.restingHeartRateAvg = v },
            "heartRateVariability" to { row: DailyAggregate, v: Double -> row.hrvAvgMs = v },
            "respiratoryRate" to { row: DailyAggregate, v: Double -> row.respiratoryRateAvg = v },
            "oxygenSaturation" to { row: DailyAggregate, v: Double -> row.oxygenSaturationAvg = v },
            "bodyTemperature" to { row: DailyAggregate, v: Double -> row.bodyTemperatureAvg = v },
        )
        latestFields.forEach { (type, setter) ->
            samplesByType[type].orEmpty()
                .groupBy { instantToLocalDate(it.startAt) }
                .forEach { (day, samples) ->
                    val latest = VitalSanity.latestChronological(samples) ?: return@forEach
                    setter(daily(day, dailyByDay), latest.value)
                }
        }
    }

    /**
     * Le scoring backend lit HealthSample (pas les agrégats journaliers) pour les calories.
     * HC n'envoie que des totaux/jour → 1 sample synthétique/jour.
     */
    private fun injectDailyScoringSamples(
        dailyRows: Collection<DailyAggregate>,
        samplesByType: MutableMap<String, MutableList<SamplePoint>>,
    ) {
        if (samplesByType["calories"]?.isNotEmpty() == true) return
        for (row in dailyRows) {
            val kcal = row.caloriesTotalKcal ?: continue
            if (kcal <= 0) continue
            val noon = row.day.atTime(12, 0).atZone(zone).toInstant()
            addSample(
                samplesByType,
                SamplePoint(
                    dataType = "calories",
                    value = kcal,
                    unit = "kilocalorie",
                    startAt = noon,
                    endAt = noon,
                    sourceId = "health_connect",
                    sourceName = "health_connect",
                    platformId = "calories|agg|${row.day}",
                ),
            )
        }
    }

    private fun addSample(map: MutableMap<String, MutableList<SamplePoint>>, sample: SamplePoint) {
        map.getOrPut(sample.dataType) { mutableListOf() }.add(sample)
    }

    private fun logSleepStageCollectSummary(sleepSamples: List<SamplePoint>) {
        if (sleepSamples.isEmpty()) {
            Log.i(tag, "sleep stades: aucun segment")
            return
        }
        val withStage = sleepSamples.count { !it.stage.isNullOrBlank() }
        val minsByStage = sleepSamples
            .filter { !it.stage.isNullOrBlank() }
            .groupBy { it.stage!! }
            .mapValues { (_, list) -> list.sumOf { it.value } to list.size }
            .toList()
            .sortedByDescending { it.second.first }
        Log.i(
            tag,
            "sleep stades (collect HC): ${withStage}/${sleepSamples.size} segment(s) avec stage",
        )
        for ((stage, pair) in minsByStage.take(8)) {
            Log.i(tag, "  · $stage: ${pair.first.toInt()} min (${pair.second} seg.)")
        }
        if (minsByStage.size > 8) {
            Log.i(tag, "  · … +${minsByStage.size - 8} autre(s) type(s) de stage")
        }
        val latestEnd = sleepSamples.maxOfOrNull { it.endAt.toEpochMilli() } ?: return
        val windowStart = latestEnd - 16L * 60 * 60 * 1000
        val nightSegs = sleepSamples.filter {
            val end = it.endAt.toEpochMilli()
            end in windowStart..latestEnd + 60_000
        }
        if (nightSegs.isEmpty()) return
        var asleepMin = 0.0
        var restorativeMin = 0.0
        for (s in nightSegs) {
            val st = s.stage?.lowercase()?.replace("_", "") ?: continue
            if (st.contains("awake") || st.contains("inbed") || st.contains("outofbed")) continue
            asleepMin += s.value
            if (st.contains("rem") || st.contains("deep")) restorativeMin += s.value
        }
        Log.i(
            tag,
            "  · dernière nuit: ~${asleepMin.toInt()} min endormi, REM+Deep ~${restorativeMin.toInt()} min (${nightSegs.size} seg.)",
        )
    }

    private val VITAL_SAMPLE_TYPES = setOf(
        "restingHeartRate",
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
        "bodyTemperature",
    )

    private fun trimAndDedupeSamples(samplesByType: MutableMap<String, MutableList<SamplePoint>>) {
        samplesByType.forEach { (type, list) ->
            val seen = HashSet<String>(list.size)
            val deduped = list
                .sortedByDescending { it.startAt }
                // Parité HC : ne pas filtrer les vitals bruts (ex. SpO₂ 56 % encore listé dans HC).
                .filter { seen.add(it.platformId) }
            // HRV / respiration : ne pas tronquer à 1000 — l'historique 60j en dépend.
            val cap = if (type in FULL_HISTORY_SAMPLE_TYPES) deduped.size else PER_TYPE_SAMPLE_LIMIT
            list.clear()
            list.addAll(deduped.take(cap))
        }
    }

    private fun logVo2AndTemperatureSummary(samplesByType: Map<String, List<SamplePoint>>) {
        val vo2 = samplesByType["vo2Max"].orEmpty()
        if (vo2.isNotEmpty()) {
            val latest = vo2.maxByOrNull { it.startAt.toEpochMilli() }
            Log.i(
                tag,
                "vo2Max (collect HC): ${vo2.size} sample(s)" +
                    (latest?.let { " | dernier=${it.value} ${it.unit} @ ${it.startAt}" } ?: ""),
            )
        } else {
            Log.i(tag, "vo2Max (collect HC): 0 sample — autoriser VO₂ max dans Health Connect")
        }

        val temps = samplesByType["bodyTemperature"].orEmpty()
        if (temps.isEmpty()) {
            Log.i(tag, "bodyTemperature (collect HC): 0 sample")
            return
        }
        val wrist = temps.count { it.origin == ORIGIN_SKIN_TEMPERATURE_WRIST }
        val core = temps.count { it.origin == ORIGIN_BODY_TEMPERATURE }
        val latest = temps.maxByOrNull { it.startAt.toEpochMilli() }
        Log.i(
            tag,
            "bodyTemperature (collect HC): ${temps.size} sample(s) (poignet=$wrist, corps=$core)" +
                (latest?.let { " | dernier=${it.value}°C origin=${it.origin ?: "?"}" } ?: ""),
        )
    }

    /**
     * Température poignet (Galaxy Watch, Pixel Watch…) via [SkinTemperatureRecord].
     * Parité iOS appleSleepingWristTemperature → dataType bodyTemperature + origin.
     */
    private suspend fun readSkinTemperatureSamples(
        start: Instant,
        end: Instant,
        granted: Set<String>,
        grantedSet: MutableSet<String>,
        deniedSet: MutableSet<String>,
        errors: MutableMap<String, String>,
        samplesByType: MutableMap<String, MutableList<SamplePoint>>,
    ) {
        val permission = HealthPermission.getReadPermission(SkinTemperatureRecord::class)
        if (permission !in granted) {
            deniedSet += "skinTemperature"
            return
        }

        val featureStatus = try {
            client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE)
        } catch (e: Exception) {
            Log.i(tag, "Skin temperature feature check: ${e.message}")
            return
        }
        if (featureStatus != HealthConnectFeatures.FEATURE_STATUS_AVAILABLE) {
            Log.i(tag, "Skin temperature HC non disponible sur ce device (status=$featureStatus)")
            return
        }

        grantedSet += "skinTemperature"
        try {
            var wristCount = 0
            readRecords<SkinTemperatureRecord>(start, end).forEach { record ->
                val location = record.measurementLocation
                record.deltas.forEachIndexed { idx, delta ->
                    val baselineC = record.baseline?.inCelsius
                    if (baselineC == null) return@forEachIndexed
                    val absolute = baselineC + delta.delta.inCelsius
                    if (!absolute.isFinite() || absolute !in 20.0..45.0) return@forEachIndexed
                    val origin = when (location) {
                        SkinTemperatureRecord.MEASUREMENT_LOCATION_WRIST ->
                            ORIGIN_SKIN_TEMPERATURE_WRIST
                        else -> "healthConnectSkinTemperature"
                    }
                    if (location == SkinTemperatureRecord.MEASUREMENT_LOCATION_WRIST) {
                        wristCount += 1
                    }
                    val pid = makePlatformId(
                        "skinTemp",
                        record.metadata,
                        delta.time.toEpochMilli(),
                        absolute,
                    ) + "|$idx"
                    addSample(
                        samplesByType,
                        SamplePoint(
                            dataType = "bodyTemperature",
                            value = absolute,
                            unit = "celsius",
                            startAt = delta.time,
                            endAt = delta.time,
                            sourceId = record.metadata.dataOrigin.packageName,
                            sourceName = record.metadata.dataOrigin.packageName,
                            platformId = if (pid.length > 255) pid.take(255) else pid,
                            origin = origin,
                        ),
                    )
                }
            }
            if (wristCount > 0) {
                Log.i(tag, "Skin temperature poignet: $wristCount delta(s)")
            }
        } catch (e: Throwable) {
            Log.w(tag, "Read skinTemperature a échoué : ${e.message}")
            errors["skinTemperature"] = (e.message ?: e.javaClass.simpleName).take(500)
        }
    }

    private suspend inline fun runRead(
        type: String,
        permission: String,
        granted: Set<String>,
        grantedSet: MutableSet<String>,
        deniedSet: MutableSet<String>,
        errors: MutableMap<String, String>,
        block: () -> Unit,
    ) {
        if (permission !in granted) {
            deniedSet += type
            return
        }
        grantedSet += type
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "Read $type a échoué : ${e.message}")
            errors[type] = (e.message ?: e.javaClass.simpleName).take(500)
        }
    }

    private fun makePlatformId(type: String, metadata: Metadata, epochMs: Long, value: Double): String {
        val nativeId = metadata.id
        val raw = if (nativeId.isNotBlank()) {
            "$type|${metadata.dataOrigin.packageName}|$nativeId"
        } else {
            "$type|${metadata.dataOrigin.packageName}|$epochMs|$value"
        }
        return if (raw.length > 255) raw.take(255) else raw
    }

    /** État partagé pour le pipeline streaming ([HealthSyncStreaming]). */
    class CollectContext(
        val granted: Set<String>,
        val grantedDataTypes: MutableSet<String> = mutableSetOf(),
        val deniedDataTypes: MutableSet<String> = mutableSetOf(),
        val errors: MutableMap<String, String> = mutableMapOf(),
        val dailyByDay: MutableMap<LocalDate, DailyAggregate> = mutableMapOf(),
    )

    suspend fun beginCollectContext(): CollectContext {
        val granted = client.permissionController.getGrantedPermissions()
        Log.i(tag, "Permissions HC accordées : ${granted.size}")
        return CollectContext(granted)
    }

    suspend fun readDailyAggregates(ctx: CollectContext, start: Instant, end: Instant) = coroutineScope {
        awaitAll(
            async {
                runRead(ctx, "steps", HealthPermission.getReadPermission(StepsRecord::class)) {
                    aggregateBuckets(start, end, listOf(StepsRecord.COUNT_TOTAL)).forEach { (day, result) ->
                        result[StepsRecord.COUNT_TOTAL]?.let { daily(day, ctx.dailyByDay).stepsTotal = it }
                    }
                    fillStepsFromRecords(start, end, ctx.dailyByDay)
                }
            },
            async {
                runRead(ctx, "calories", HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class)) {
                    aggregateBuckets(start, end, listOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL))
                        .forEach { (day, result) ->
                            result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories?.let {
                                daily(day, ctx.dailyByDay).caloriesTotalKcal = it
                            }
                        }
                    fillCaloriesFromRecords(start, end, ctx.dailyByDay)
                }
            },
        )
    }

    /** Sommeil → sleep_total_min sur dailyByDay (attribution jour de réveil). */
    suspend fun enrichDailyWithSleep(ctx: CollectContext, start: Instant, end: Instant) {
        val sleepSamples = readSampleType(ctx, "sleep", start, end)
        SleepNightAttribution.applyWakeDayTotals(ctx.dailyByDay, sleepSamples, zone)
        val nights = ctx.dailyByDay.count { it.value.sleepTotalMin != null && it.value.sleepTotalMin!! > 0 }
        if (nights > 0) {
            Log.i(tag, "Sommeil daily-extended: ${sleepSamples.size} segment(s) → $nights nuit(s)")
        }
    }

    /** Vitaux j 61–365 : 1 sample/jour (saisies manuelles HC incluses). */
    suspend fun readDailyExtendedVitalsCompact(
        ctx: CollectContext,
        start: Instant,
        end: Instant,
    ): Map<String, List<SamplePoint>> {
        val sleepRaw = readSampleType(ctx, "sleep", start, end)
        val nightIndex = HistoricalLightCompactor.buildWakeDayNightTimestampIndex(
            sleepRaw,
            ctx.dailyByDay,
            zone,
            historicalLight = false,
        )
        val out = linkedMapOf<String, List<SamplePoint>>()
        val types = listOf(
            "heartRateVariability",
            "respiratoryRate",
            "oxygenSaturation",
            "bodyTemperature",
        )
        for (type in types) {
            val raw = readSampleType(ctx, type, start, end)
            if (raw.isEmpty()) continue
            val collapsed = ScoreRingDailyFilter.filterVitalSamples(
                HistoricalLightCompactor.compactVitalsForDailyExtended(raw, type, zone, nightIndex),
                zone,
            )
            if (collapsed.isEmpty()) continue
            Log.i(tag, "Vitaux daily-extended $type: ${raw.size} bruts → ${collapsed.size} jour(s)")
            out[type] = collapsed
            rollupDailyLatestVitals(mapOf(type to collapsed), ctx.dailyByDay)
        }
        return out
    }

    fun buildScoringSamples(dailyByDay: Map<LocalDate, DailyAggregate>): Map<String, List<SamplePoint>> {
        val out = mutableMapOf<String, MutableList<SamplePoint>>()
        for (row in dailyByDay.values) {
            if (ScoreRingDailyFilter.isFutureDay(row.day, zone)) continue
            val steps = row.stepsTotal
            if (steps != null && steps > 0L) {
                val noon = row.day.atTime(12, 0).atZone(zone).toInstant()
                addSample(
                    out,
                    SamplePoint(
                        dataType = "steps",
                        value = steps.toDouble(),
                        unit = "count",
                        startAt = noon,
                        endAt = noon,
                        sourceId = "health_connect",
                        sourceName = "health_connect",
                        platformId = "steps|agg|${row.day}",
                    ),
                )
            }
            val kcal = row.caloriesTotalKcal
            if (kcal != null && kcal > 0.0) {
                val noon = row.day.atTime(12, 0).atZone(zone).toInstant()
                addSample(
                    out,
                    SamplePoint(
                        dataType = "calories",
                        value = kcal,
                        unit = "kilocalorie",
                        startAt = noon,
                        endAt = noon,
                        sourceId = "health_connect",
                        sourceName = "health_connect",
                        platformId = "calories|agg|${row.day}",
                    ),
                )
            }
        }
        return out
    }

    suspend fun readSampleType(
        ctx: CollectContext,
        type: String,
        start: Instant,
        end: Instant,
    ): List<SamplePoint> {
        val samplesByType = mutableMapOf<String, MutableList<SamplePoint>>()
        when (type) {
            "restingHeartRate" -> runRead(ctx, type, HealthPermission.getReadPermission(RestingHeartRateRecord::class)) {
                readRecords<RestingHeartRateRecord>(start, end).forEach { record ->
                    addSample(samplesByType, sampleFromRestingHr(record))
                }
            }
            "heartRateVariability" -> runRead(ctx, type, HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class)) {
                readRecords<HeartRateVariabilityRmssdRecord>(start, end).forEach { record ->
                    addSample(samplesByType, sampleFromHrv(record))
                }
            }
            "respiratoryRate" -> runRead(ctx, type, HealthPermission.getReadPermission(RespiratoryRateRecord::class)) {
                readRecords<RespiratoryRateRecord>(start, end).forEach { record ->
                    addSample(samplesByType, sampleFromRespiratory(record))
                }
            }
            "oxygenSaturation" -> runRead(ctx, type, HealthPermission.getReadPermission(OxygenSaturationRecord::class)) {
                readRecords<OxygenSaturationRecord>(start, end).forEach { record ->
                    addSample(samplesByType, sampleFromSpo2(record))
                }
            }
            "bodyTemperature" -> {
                runRead(ctx, type, HealthPermission.getReadPermission(BodyTemperatureRecord::class)) {
                    readRecords<BodyTemperatureRecord>(start, end).forEach { record ->
                        addSample(samplesByType, sampleFromBodyTemp(record))
                    }
                }
                readSkinTemperatureSamples(
                    start, end, ctx.granted, ctx.grantedDataTypes, ctx.deniedDataTypes, ctx.errors, samplesByType,
                )
            }
            "vo2Max" -> runRead(ctx, type, HealthPermission.getReadPermission(Vo2MaxRecord::class)) {
                readRecords<Vo2MaxRecord>(start, end).forEach { record ->
                    addSample(samplesByType, sampleFromVo2(record))
                }
            }
            "sleep" -> runRead(ctx, type, HealthPermission.getReadPermission(SleepSessionRecord::class)) {
                readRecords<SleepSessionRecord>(start, end).forEach { session ->
                    addSleepSessionSamples(session, samplesByType)
                }
            }
        }
        return samplesByType[type].orEmpty()
    }

    suspend fun readWorkouts(ctx: CollectContext, start: Instant, end: Instant): List<WorkoutPoint> {
        val workouts = mutableListOf<WorkoutPoint>()
        runRead(ctx, "workouts", HealthPermission.getReadPermission(ExerciseSessionRecord::class)) {
            readRecords<ExerciseSessionRecord>(start, end).forEach { session ->
                workouts += workoutFromSession(session)
            }
        }
        return workouts
    }

    suspend fun readWorkoutHeartRates(ctx: CollectContext, workouts: List<WorkoutPoint>): List<SamplePoint> {
        if (workouts.isEmpty()) return emptyList()
        val samplesByType = mutableMapOf<String, MutableList<SamplePoint>>()
        runRead(ctx, "heartRate", HealthPermission.getReadPermission(HeartRateRecord::class)) {
            var hrSamples = 0
            for (workout in workouts) {
                readRecords<HeartRateRecord>(workout.startAt, workout.endAt).forEach { record ->
                    record.samples.forEach { sample ->
                        hrSamples += 1
                        addSample(
                            samplesByType,
                            SamplePoint(
                                dataType = "heartRate",
                                value = sample.beatsPerMinute.toDouble(),
                                unit = "bpm",
                                startAt = sample.time,
                                endAt = sample.time,
                                sourceId = record.metadata.dataOrigin.packageName,
                                sourceName = record.metadata.dataOrigin.packageName,
                                platformId = makePlatformId(
                                    "heartRate",
                                    record.metadata,
                                    sample.time.toEpochMilli(),
                                    sample.beatsPerMinute.toDouble(),
                                ),
                            ),
                        )
                    }
                }
            }
            if (hrSamples > 0) {
                Log.i(tag, "FC workout: $hrSamples sample(s) sur ${workouts.size} séance(s)")
            }
        }
        return samplesByType["heartRate"].orEmpty()
    }

    fun finalizeSamples(
        ctx: CollectContext,
        samplesByType: MutableMap<String, MutableList<SamplePoint>>,
        phaseLabel: String,
    ) {
        injectDailyScoringSamples(ctx.dailyByDay.values, samplesByType)
        rollupDailyLatestVitals(samplesByType, ctx.dailyByDay)
        SleepNightAttribution.applyWakeDayTotals(
            ctx.dailyByDay,
            samplesByType["sleep"] ?: emptyList(),
            zone,
        )
        HistoricalLightCompactor.apply(samplesByType, ctx.dailyByDay, phaseLabel, zone)
        trimAndDedupeSamples(samplesByType)
        logSleepStageCollectSummary(samplesByType["sleep"] ?: emptyList())
        logVo2AndTemperatureSummary(samplesByType)
    }

    /** Réparation 1× des sleep_total_min (attribution jour de réveil, stades endormis uniquement). */
    suspend fun collectSleepDailyRepair(startMs: Long, endMs: Long): SyncPayload {
        val start = Instant.ofEpochMilli(startMs)
        val end = Instant.ofEpochMilli(endMs)
        val zone = ZoneId.systemDefault()
        val ctx = beginCollectContext()
        val sleepSamples = readSampleType(ctx, "sleep", start, end)
        val dailyByDay = mutableMapOf<LocalDate, DailyAggregate>()
        SleepNightAttribution.applyWakeDayTotals(dailyByDay, sleepSamples, zone)
        val rows = dailyByDay.values
            .filter { it.sleepTotalMin != null && it.sleepTotalMin!! > 0 }
            .sortedBy { it.day }
        Log.i(tag, "Sleep daily repair: ${sleepSamples.size} segment(s) → ${rows.size} jour(s)")
        return SyncPayload(
            windowStart = start,
            windowEnd = end,
            grantedDataTypes = ctx.grantedDataTypes.toList(),
            deniedDataTypes = ctx.deniedDataTypes.toList(),
            errors = ctx.errors,
            samplesByType = emptyMap(),
            dailyAggregates = rows,
            workouts = emptyList(),
        )
    }

    /** Réparation ciblée j 8–60 : stades sommeil compacts (constance horaires / réparateur). */
    suspend fun collectSleepStagesRepairOnly(startMs: Long, endMs: Long): SyncPayload {
        val start = Instant.ofEpochMilli(startMs)
        val end = Instant.ofEpochMilli(endMs)
        val ctx = beginCollectContext()
        val samplesByType = mutableMapOf<String, MutableList<SamplePoint>>()
        val sleepSamples = readSampleType(ctx, "sleep", start, end).toMutableList()
        samplesByType["sleep"] = sleepSamples
        val dailyByDay = mutableMapOf<LocalDate, DailyAggregate>()
        SleepNightAttribution.applyWakeDayTotals(dailyByDay, sleepSamples, zone)
        HistoricalLightCompactor.apply(samplesByType, dailyByDay, "historical", zone)
        trimAndDedupeSamples(samplesByType)
        logSleepStageCollectSummary(samplesByType["sleep"] ?: emptyList())
        val compacted = samplesByType["sleep"] ?: emptyList()
        Log.i(
            tag,
            "Sleep stages repair: ${sleepSamples.size} bruts → ${compacted.size} segment(s) compacts",
        )
        return SyncPayload(
            windowStart = start,
            windowEnd = end,
            grantedDataTypes = ctx.grantedDataTypes.toList(),
            deniedDataTypes = ctx.deniedDataTypes.toList(),
            errors = ctx.errors,
            samplesByType = samplesByType,
            dailyAggregates = emptyList(),
            workouts = emptyList(),
        )
    }

    fun buildPartialPayload(
        ctx: CollectContext,
        start: Instant,
        end: Instant,
        samplesByType: Map<String, List<SamplePoint>>,
        workouts: List<WorkoutPoint>,
        dailyOverlay: List<DailyAggregate>,
    ): SyncPayload = SyncPayload(
        windowStart = start,
        windowEnd = end,
        grantedDataTypes = ctx.grantedDataTypes.toList(),
        deniedDataTypes = ctx.deniedDataTypes.toList(),
        errors = ctx.errors,
        samplesByType = samplesByType,
        dailyAggregates = dailyOverlay,
        workouts = workouts,
    )

    private suspend inline fun runRead(
        ctx: CollectContext,
        type: String,
        permission: String,
        block: () -> Unit,
    ) = runRead(type, permission, ctx.granted, ctx.grantedDataTypes, ctx.deniedDataTypes, ctx.errors, block)

    private fun sampleFromRestingHr(record: RestingHeartRateRecord) = SamplePoint(
        dataType = "restingHeartRate",
        value = record.beatsPerMinute.toDouble(),
        unit = "bpm",
        startAt = record.time,
        endAt = record.time,
        sourceId = record.metadata.dataOrigin.packageName,
        sourceName = record.metadata.dataOrigin.packageName,
        platformId = makePlatformId("restingHeartRate", record.metadata, record.time.toEpochMilli(), record.beatsPerMinute.toDouble()),
    )

    private fun sampleFromHrv(record: HeartRateVariabilityRmssdRecord) = SamplePoint(
        dataType = "heartRateVariability",
        value = record.heartRateVariabilityMillis,
        unit = "millisecond",
        startAt = record.time,
        endAt = record.time,
        sourceId = record.metadata.dataOrigin.packageName,
        sourceName = record.metadata.dataOrigin.packageName,
        platformId = makePlatformId("heartRateVariability", record.metadata, record.time.toEpochMilli(), record.heartRateVariabilityMillis),
    )

    private fun sampleFromRespiratory(record: RespiratoryRateRecord) = SamplePoint(
        dataType = "respiratoryRate",
        value = record.rate,
        unit = "bpm",
        startAt = record.time,
        endAt = record.time,
        sourceId = record.metadata.dataOrigin.packageName,
        sourceName = record.metadata.dataOrigin.packageName,
        platformId = makePlatformId("respiratoryRate", record.metadata, record.time.toEpochMilli(), record.rate),
    )

    private fun sampleFromSpo2(record: OxygenSaturationRecord): SamplePoint {
        val pct = if (record.percentage.value in 0.0..1.0) record.percentage.value * 100.0 else record.percentage.value
        return SamplePoint(
            dataType = "oxygenSaturation",
            value = pct,
            unit = "percent",
            startAt = record.time,
            endAt = record.time,
            sourceId = record.metadata.dataOrigin.packageName,
            sourceName = record.metadata.dataOrigin.packageName,
            platformId = makePlatformId("oxygenSaturation", record.metadata, record.time.toEpochMilli(), pct),
        )
    }

    private fun sampleFromBodyTemp(record: BodyTemperatureRecord) = SamplePoint(
        dataType = "bodyTemperature",
        value = record.temperature.inCelsius,
        unit = "celsius",
        startAt = record.time,
        endAt = record.time,
        sourceId = record.metadata.dataOrigin.packageName,
        sourceName = record.metadata.dataOrigin.packageName,
        platformId = makePlatformId("bodyTemperature", record.metadata, record.time.toEpochMilli(), record.temperature.inCelsius),
        origin = ORIGIN_BODY_TEMPERATURE,
    )

    private fun sampleFromVo2(record: Vo2MaxRecord) = SamplePoint(
        dataType = "vo2Max",
        value = record.vo2MillilitersPerMinuteKilogram,
        unit = "milliliterPerKilogramPerMinute",
        startAt = record.time,
        endAt = record.time,
        sourceId = record.metadata.dataOrigin.packageName,
        sourceName = record.metadata.dataOrigin.packageName,
        platformId = makePlatformId("vo2Max", record.metadata, record.time.toEpochMilli(), record.vo2MillilitersPerMinuteKilogram),
        origin = ORIGIN_VO2_MAX,
    )

    private fun workoutFromSession(session: ExerciseSessionRecord): WorkoutPoint {
        val durationSec = (session.endTime.epochSecond - session.startTime.epochSecond).coerceAtLeast(0)
        val typeName = ExerciseSessionRecord.EXERCISE_TYPE_INT_TO_STRING_MAP[session.exerciseType]
            ?.lowercase(Locale.ROOT)
            ?: "other_workout"
        return WorkoutPoint(
            workoutType = typeName,
            duration = durationSec.toInt(),
            totalEnergyBurned = null,
            totalDistance = null,
            startAt = session.startTime,
            endAt = session.endTime,
            sourceId = session.metadata.dataOrigin.packageName,
            sourceName = session.metadata.dataOrigin.packageName,
            platformId = makePlatformId("workout", session.metadata, session.startTime.toEpochMilli(), durationSec.toDouble()),
        )
    }

    companion object {
        private const val PAGE_SIZE = 500
        private const val MAX_PAGES = 80

        /** Plafond pour FC / SpO₂ / etc. HRV/respiration exclus (historique 60j). */
        private const val PER_TYPE_SAMPLE_LIMIT = 10_000

        /** Types denses : pas de plafond à l'envoi. */
        private val FULL_HISTORY_SAMPLE_TYPES = setOf(
            "heartRateVariability",
            "respiratoryRate",
            "sleep",
            "vo2Max",
            "bodyTemperature",
        )

        val ALL_READ_PERMISSIONS: Set<String> = setOf(
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(RestingHeartRateRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
            HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
            HealthPermission.getReadPermission(RespiratoryRateRecord::class),
            HealthPermission.getReadPermission(OxygenSaturationRecord::class),
            HealthPermission.getReadPermission(BodyTemperatureRecord::class),
            HealthPermission.getReadPermission(SkinTemperatureRecord::class),
            HealthPermission.getReadPermission(Vo2MaxRecord::class),
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        )

        /** Aligné iOS : 90 jours intraday scoring au premier sync. */
        const val DEFAULT_LOOKBACK_MS: Long = 90L * 24 * 60 * 60 * 1000

        const val ORIGIN_SKIN_TEMPERATURE_WRIST = "healthConnectSkinTemperatureWrist"
        const val ORIGIN_BODY_TEMPERATURE = "BodyTemperatureRecord"
        const val ORIGIN_VO2_MAX = "Vo2MaxRecord"
    }
}

data class SyncPayload(
    val windowStart: Instant,
    val windowEnd: Instant,
    val grantedDataTypes: List<String>,
    val deniedDataTypes: List<String>,
    val errors: Map<String, String>,
    val samplesByType: Map<String, List<SamplePoint>>,
    val dailyAggregates: List<DailyAggregate>,
    val workouts: List<WorkoutPoint> = emptyList(),
) {
    fun isEmpty(): Boolean =
        samplesByType.values.all { it.isEmpty() } &&
            dailyAggregates.none { it.hasAnyValue() } &&
            workouts.isEmpty()

    fun totalSampleCount(): Int = samplesByType.values.sumOf { it.size }
}

data class SamplePoint(
    val dataType: String,
    val value: Double,
    val unit: String,
    val startAt: Instant,
    val endAt: Instant,
    val sourceId: String?,
    val sourceName: String?,
    val platformId: String,
    val diastolic: Double? = null,
    /** Raw OS sleep stage (Health Connect stage_type_*), contract v1. */
    val stage: String? = null,
    /** Source HC/HK identifier (ex. poignet Watch, Vo2MaxRecord). */
    val origin: String? = null,
)

data class WorkoutPoint(
    val workoutType: String,
    val duration: Int?,
    val totalEnergyBurned: Double?,
    val totalDistance: Double?,
    val startAt: Instant,
    val endAt: Instant,
    val sourceId: String?,
    val sourceName: String?,
    val platformId: String,
)

data class DailyAggregate(
    val day: LocalDate,
    var stepsTotal: Long? = null,
    var distanceTotalM: Double? = null,
    var caloriesTotalKcal: Double? = null,
    var sleepTotalMin: Int? = null,
    var restingHeartRateAvg: Double? = null,
    var hrvAvgMs: Double? = null,
    var respiratoryRateAvg: Double? = null,
    var oxygenSaturationAvg: Double? = null,
    var bodyTemperatureAvg: Double? = null,
    val extra: MutableMap<String, Any> = mutableMapOf(),
) {
    fun hasAnyValue(): Boolean =
        stepsTotal != null || distanceTotalM != null || caloriesTotalKcal != null ||
            sleepTotalMin != null || restingHeartRateAvg != null || hrvAvgMs != null ||
            respiratoryRateAvg != null || oxygenSaturationAvg != null || bodyTemperatureAvg != null ||
            extra.isNotEmpty()
}
