package com.pcpinnov.pcpttherapy.health

import android.util.Log
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.math.round

/**
 * Mode historique léger (jours 8–60) et incrémental compact — parité iOS
 * [health-ios-sync.js] collapseVitalSamplesToDailySynthetic + sleep stades compacts.
 *
 * IDs stables pour upsert backend (Lucas) :
 * - `{type}|agg|{wakeDay}` — vitaux compacts
 * - `sleep|compact|{wakeDay}::night` — sommeil incrémental (intervalles réels)
 * - `sleep|hist|{wakeDay}::{bucket}|{idx}` — sommeil historique stagé
 * - `sleep|agg|{day}::night` — repli synthétique
 * - `sleep|companion|{wakeDay}::companion`
 */
object HistoricalLightCompactor {

    private const val TAG = "HistoricalLight"
    private val HISTORICAL_LIGHT = setOf("historical", "bg-historical")
    private val INCREMENTAL_COMPACT = setOf("incremental")

    private val VITAL_COMPACT_TYPES = setOf(
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
    )

    fun isHistoricalLight(phaseLabel: String): Boolean =
        phaseLabel in HISTORICAL_LIGHT

    fun isIncrementalCompact(phaseLabel: String): Boolean =
        phaseLabel in INCREMENTAL_COMPACT

    fun useVitalCompact(phaseLabel: String): Boolean =
        isHistoricalLight(phaseLabel) || isIncrementalCompact(phaseLabel)

    fun useSleepCompact(phaseLabel: String): Boolean =
        useVitalCompact(phaseLabel)

    fun apply(
        samplesByType: MutableMap<String, MutableList<SamplePoint>>,
        dailyByDay: Map<LocalDate, DailyAggregate>,
        phaseLabel: String,
        zone: ZoneId,
    ) {
        if (!useVitalCompact(phaseLabel)) return

        val label = if (isHistoricalLight(phaseLabel)) "léger" else "compact"
        Log.i(TAG, "Phase $phaseLabel — mode $label")

        val sleepRaw = samplesByType["sleep"] ?: emptyList()
        val nightIndex = buildWakeDayNightTimestampIndex(sleepRaw, dailyByDay, zone, phaseLabel)

        for (type in VITAL_COMPACT_TYPES) {
            val raw = samplesByType[type] ?: continue
            if (raw.isEmpty()) continue
            val collapsed = collapseVitalsToDaily(raw, type, zone, useMedian = type == "heartRateVariability", nightIndex)
            if (collapsed.isNotEmpty()) {
                Log.i(TAG, "  $type $label: ${raw.size} bruts → ${collapsed.size} jour(s)")
                samplesByType[type] = collapsed.toMutableList()
            }
        }

        val temps = samplesByType["bodyTemperature"]
        if (!temps.isNullOrEmpty()) {
            val shouldCollapse = isHistoricalLight(phaseLabel) && temps.size > 50
            if (shouldCollapse) {
                val collapsed = collapseVitalsToDaily(temps, "bodyTemperature", zone, useMedian = false, nightIndex)
                if (collapsed.isNotEmpty()) {
                    Log.i(TAG, "  bodyTemperature $label: ${temps.size} bruts → ${collapsed.size} jour(s)")
                    samplesByType["bodyTemperature"] = collapsed.toMutableList()
                }
            }
        }

        if (sleepRaw.isEmpty()) return

        val compacted = buildSleepCompactSamplesFromRaw(
            sleepRaw,
            dailyByDay,
            zone,
            historicalLight = isHistoricalLight(phaseLabel),
        )

        if (compacted.isNotEmpty()) {
            val nights = clusterSleepIntoNights(sleepRaw.filter { !it.stage.isNullOrBlank() }, zone).size
            val mode = describeSleepCompactPostMode(compacted)
            Log.i(
                TAG,
                "  sleep ($label): ${sleepRaw.size} bruts → ${compacted.size} sample(s) ($mode" +
                    if (nights > 0) ", $nights nuit(s) HK)" else ")",
            )
            samplesByType["sleep"] = compacted.toMutableList()
        } else if (sleepRaw.isNotEmpty()) {
            Log.i(TAG, "  sleep $label: repli segments bruts (${sleepRaw.size})")
        }
    }

    fun compactVitalsForDailyExtended(
        samples: List<SamplePoint>,
        dataType: String,
        zone: ZoneId,
        nightIndex: Map<LocalDate, Instant> = emptyMap(),
    ): List<SamplePoint> = collapseVitalsToDaily(
        samples,
        dataType,
        zone,
        useMedian = dataType == "heartRateVariability",
        nightIndex,
    )

    private fun collapseVitalsToDaily(
        samples: List<SamplePoint>,
        dataType: String,
        zone: ZoneId,
        useMedian: Boolean,
        nightIndex: Map<LocalDate, Instant>,
    ): List<SamplePoint> {
        val byWake = samples.groupBy { vitalWakeDay(it.startAt, zone) }
        val out = mutableListOf<SamplePoint>()
        for ((wakeDay, list) in byWake) {
            if (ScoreRingDailyFilter.isFutureDay(wakeDay, zone)) continue
            val vals = list.map { it.value }.filter { it.isFinite() && it > 0 }
            if (vals.isEmpty()) continue
            val value = if (useMedian) median(vals) else average(vals) ?: continue
            if (value <= 0) continue
            val instant = nightIndex[wakeDay] ?: dailyWakeFallbackInstant(wakeDay)
            val rounded = round(value * 100.0) / 100.0
            out += SamplePoint(
                dataType = dataType,
                value = rounded,
                unit = list.first().unit,
                startAt = instant,
                endAt = instant,
                sourceId = "health_connect",
                sourceName = "health_connect",
                platformId = "${dataType}|agg|$wakeDay".take(255),
                origin = list.firstOrNull { it.origin != null }?.origin,
            )
        }
        return out
    }

    fun vitalWakeDay(instant: Instant, zone: ZoneId): LocalDate {
        val zdt = instant.atZone(ZoneOffset.UTC)
        val localDay = instant.atZone(zone).toLocalDate()
        val h = zdt.hour
        return when {
            h >= 20 -> localDay.plusDays(1)
            h < 10 -> localDay
            else -> localDay
        }
    }

    private fun dailyWakeFallbackInstant(wakeDay: LocalDate): Instant =
        wakeDay.atTime(4, 0).toInstant(ZoneOffset.UTC)

    private fun isNonSleepStageForVitalIndex(stage: String?): Boolean {
        if (stage.isNullOrBlank()) return false
        val n = stage.lowercase()
        return n.contains("awake") || n.contains("inbed") || n.contains("in_bed")
    }

    fun buildWakeDayNightTimestampIndex(
        sleepRaw: List<SamplePoint>,
        dailyByDay: Map<LocalDate, DailyAggregate>,
        zone: ZoneId,
        phaseLabel: String,
    ): Map<LocalDate, Instant> {
        val staged = if (useSleepCompact(phaseLabel)) {
            buildSleepCompactSamplesFromRaw(
                sleepRaw,
                dailyByDay,
                zone,
                historicalLight = isHistoricalLight(phaseLabel),
            )
        } else {
            buildSleepSyntheticFromDaily(dailyByDay, zone)
        }
        val best = mutableMapOf<LocalDate, Pair<Long, Instant>>()
        for (s in staged) {
            if (isNonSleepStageForVitalIndex(s.stage)) continue
            if (!s.endAt.isAfter(s.startAt)) continue
            val wakeDay = instantToLocalDate(s.endAt, zone)
            val dur = s.endAt.epochSecond - s.startAt.epochSecond
            val mid = s.startAt.plusSeconds(dur / 2)
            val prev = best[wakeDay]
            if (prev == null || dur > prev.first) {
                best[wakeDay] = dur to mid
            }
        }
        return best.mapValues { it.value.second }
    }

    fun vitalWakeDayFromInstant(instant: Instant, zone: ZoneId): LocalDate =
        vitalWakeDay(instant, zone)

    fun buildCompanionSleepForWakeDays(
        wakeDays: Set<LocalDate>,
        sleepRaw: List<SamplePoint>,
        zone: ZoneId,
    ): List<SamplePoint> {
        val staged = compactSleepStagedHistorical(sleepRaw, zone)
        val bestByWake = mutableMapOf<LocalDate, SamplePoint>()
        for (s in staged) {
            if (isNonSleepStageForVitalIndex(s.stage)) continue
            if (!s.endAt.isAfter(s.startAt)) continue
            val wakeDay = instantToLocalDate(s.endAt, zone)
            val dur = s.endAt.epochSecond - s.startAt.epochSecond
            val prev = bestByWake[wakeDay]
            if (prev == null || dur > (prev.endAt.epochSecond - prev.startAt.epochSecond)) {
                bestByWake[wakeDay] = s
            }
        }

        val out = mutableListOf<SamplePoint>()
        for (wakeDay in wakeDays) {
            val existing = bestByWake[wakeDay]
            if (existing != null) {
                out += existing
                continue
            }
            val startAt = wakeDay.minusDays(1).atTime(22, 0).toInstant(ZoneOffset.UTC)
            val endAt = wakeDay.atTime(10, 0).toInstant(ZoneOffset.UTC)
            val mins = (endAt.epochSecond - startAt.epochSecond) / 60.0
            if (mins <= 0) continue
            out += buildSleepStageSample(
                sourceName = "health_connect",
                sourceId = "health_connect",
                stage = "asleep",
                startAt = startAt,
                endAt = endAt,
                parentPlatformId = "sleep|companion|$wakeDay",
                segmentKey = "companion",
            ) ?: continue
        }
        return out
    }

    /**
     * historicalLight → stades compacts si REM/Deep/Core.
     * incremental → intervalles réels sauf vrais stades détaillés.
     */
    fun buildSleepCompactSamplesFromRaw(
        rawList: List<SamplePoint>,
        dailyByDay: Map<LocalDate, DailyAggregate>,
        zone: ZoneId,
        historicalLight: Boolean,
    ): List<SamplePoint> {
        if (rawList.isEmpty()) return emptyList()
        val staged = compactSleepStagedHistorical(rawList, zone)
        if (staged.isNotEmpty() && (historicalLight || hasDetailedSleepStages(staged))) {
            return staged
        }
        val real = buildSleepRealIntervalSamplesFromRaw(rawList, dailyByDay, zone)
        if (real.isNotEmpty()) return real
        return buildSleepSyntheticFromDaily(dailyByDay, zone)
    }

    private fun hasDetailedSleepStages(samples: List<SamplePoint>): Boolean {
        for (s in samples) {
            when (canonicalSleepStageBucket(s.stage)) {
                "REM", "Deep", "Core" -> return true
            }
        }
        return false
    }

    private fun describeSleepCompactPostMode(samples: List<SamplePoint>): String {
        if (samples.isEmpty()) return "vide"
        val pid = samples.first().platformId
        return when {
            pid.contains("sleep|compact|") -> "intervalles réels"
            pid.contains("sleep|hist|") -> "stades compacts"
            pid.contains("sleep|agg|") -> "synthétique"
            else -> "brut"
        }
    }

    private fun canonicalSleepStageBucket(stageName: String?): String {
        val n = (stageName ?: "").lowercase().replace("_", "").replace(" ", "")
        if (n.isEmpty()) return "Asleep"
        if (n.contains("rem")) return "REM"
        if (n.contains("deep")) return "Deep"
        if (n.contains("core") || n.contains("light")) return "Core"
        if (n.contains("awake")) return "Awake"
        if (n.contains("inbed")) return "InBed"
        if (n.contains("asleep") || n.contains("sleeping")) return "Asleep"
        return stageName ?: "Asleep"
    }

    private fun sleepSourcePriority(label: String?): Int {
        val n = (label ?: "").lowercase()
        return when {
            n.contains("watch") -> 3
            n.contains("wear") -> 3
            n.contains("phone") -> 2
            else -> 1
        }
    }

    private fun buildSleepStageSample(
        sourceName: String?,
        sourceId: String?,
        stage: String?,
        startAt: Instant,
        endAt: Instant,
        parentPlatformId: String,
        segmentKey: String,
    ): SamplePoint? {
        if (!endAt.isAfter(startAt)) return null
        val mins = (endAt.epochSecond - startAt.epochSecond) / 60.0
        if (mins < 0.01) return null
        val platformId = "${parentPlatformId.take(200)}::$segmentKey".take(255)
        return SamplePoint(
            dataType = "sleep",
            value = mins,
            unit = "minute",
            startAt = startAt,
            endAt = endAt,
            sourceId = sourceId,
            sourceName = sourceName,
            platformId = platformId,
            stage = stage,
        )
    }

    /** Historique : fusion par stade/nuit avec horaires réels (REM+Deep pour scoring). */
    private fun compactSleepStagedHistorical(
        samples: List<SamplePoint>,
        zone: ZoneId,
    ): List<SamplePoint> {
        val withStage = samples.filter { !it.stage.isNullOrBlank() }
        if (withStage.isEmpty()) return emptyList()

        val nights = clusterSleepIntoNights(withStage, zone)
        val out = mutableListOf<SamplePoint>()

        for (nightSamples in nights) {
            val bySrc = nightSamples.groupBy { it.sourceName ?: it.sourceId ?: "unknown" }
            var bestList = nightSamples
            var bestPri = -1
            for ((src, list) in bySrc) {
                val pri = sleepSourcePriority(src)
                if (pri > bestPri) {
                    bestPri = pri
                    bestList = list
                }
            }

            var wakeDay: LocalDate? = null
            for (s in bestList) {
                val d = instantToLocalDate(s.endAt, zone)
                if (wakeDay == null || d.isAfter(wakeDay)) wakeDay = d
            }
            val wake = wakeDay ?: continue

            val byBucket = bestList.groupBy { canonicalSleepStageBucket(it.stage) }
            for ((bucket, segs) in byBucket) {
                val merged = mergeAdjacentSegments(segs)
                merged.forEachIndexed { idx, seg ->
                    val sample = buildSleepStageSample(
                        sourceName = seg.sourceName,
                        sourceId = seg.sourceId,
                        stage = bucket,
                        startAt = seg.startAt,
                        endAt = seg.endAt,
                        parentPlatformId = "sleep|hist|$wake",
                        segmentKey = "$bucket|$idx",
                    ) ?: return@forEachIndexed
                    out += sample
                }
            }
        }
        return out
    }

    /** 1 sample/nuit avec vrais horaires HC (pas de midi synthétique). */
    private fun buildSleepRealIntervalSamplesFromRaw(
        rawList: List<SamplePoint>,
        dailyByDay: Map<LocalDate, DailyAggregate>,
        zone: ZoneId,
    ): List<SamplePoint> {
        val nights = clusterSleepIntoNights(rawList.filter { !it.stage.isNullOrBlank() }.ifEmpty { rawList }, zone)
        val out = mutableListOf<SamplePoint>()

        for (nightSamples in nights) {
            val bySrc = nightSamples.groupBy { it.sourceName ?: it.sourceId ?: "unknown" }
            var bestMetrics: NightMetrics? = null
            var bestPri = -1
            var bestSource = "health_connect"

            for ((src, list) in bySrc) {
                val metrics = collectSleepNightMetrics(list, dailyByDay, zone) ?: continue
                val pri = sleepSourcePriority(src)
                if (
                    bestMetrics == null ||
                    pri > bestPri ||
                    (pri == bestPri && metrics.asleepMin > bestMetrics.asleepMin)
                ) {
                    bestPri = pri
                    bestMetrics = metrics
                    bestSource = src
                }
            }

            val m = bestMetrics ?: continue
            val sample = buildSleepStageSample(
                sourceName = bestSource,
                sourceId = bestSource,
                stage = null,
                startAt = m.startAt,
                endAt = m.endAt,
                parentPlatformId = "sleep|compact|${m.wakeDay}",
                segmentKey = "night",
            ) ?: continue
            out += sample.copy(value = m.asleepMin.toDouble())
        }
        return out
    }

    private data class NightMetrics(
        val wakeDay: LocalDate,
        val asleepMin: Int,
        val startAt: Instant,
        val endAt: Instant,
    )

    private fun collectSleepNightMetrics(
        nightSamples: List<SamplePoint>,
        dailyByDay: Map<LocalDate, DailyAggregate>,
        zone: ZoneId,
    ): NightMetrics? {
        var windowMinStart: Instant? = null
        var windowMaxEnd: Instant? = null
        var asleepMin = 0.0

        for (s in nightSamples) {
            if (!SleepNightAttribution.isAsleepStage(s.stage)) {
                if (s.stage.isNullOrBlank() && s.value > 0) {
                    val start = s.startAt
                    val end = s.endAt
                    if (windowMinStart == null || start.isBefore(windowMinStart)) windowMinStart = start
                    if (windowMaxEnd == null || end.isAfter(windowMaxEnd)) windowMaxEnd = end
                    asleepMin += s.value
                }
                continue
            }
            if (!s.endAt.isAfter(s.startAt)) continue
            val start = s.startAt
            val end = s.endAt
            if (windowMinStart == null || start.isBefore(windowMinStart)) windowMinStart = start
            if (windowMaxEnd == null || end.isAfter(windowMaxEnd)) windowMaxEnd = end
            asleepMin += s.value
        }

        val minStart = windowMinStart ?: return null
        val maxEnd = windowMaxEnd ?: return null
        val wakeDay = instantToLocalDate(maxEnd, zone)

        var mins = asleepMin.toInt()
        val aggMin = dailyByDay[wakeDay]?.sleepTotalMin ?: 0
        if (mins <= 0 && aggMin > 0) mins = aggMin
        if (mins <= 0) {
            mins = ((maxEnd.epochSecond - minStart.epochSecond) / 60).toInt()
        }
        if (mins <= 0) return null

        return NightMetrics(wakeDay, mins, minStart, maxEnd)
    }

    private data class TimeSegment(
        val startAt: Instant,
        val endAt: Instant,
        val sourceId: String?,
        val sourceName: String?,
    )

    private fun mergeAdjacentSegments(segs: List<SamplePoint>): List<TimeSegment> {
        val sorted = segs
            .map { TimeSegment(it.startAt, it.endAt, it.sourceId, it.sourceName) }
            .filter { it.endAt.isAfter(it.startAt) }
            .sortedBy { it.startAt }
        if (sorted.isEmpty()) return emptyList()

        val merged = mutableListOf<TimeSegment>()
        for (seg in sorted) {
            val last = merged.lastOrNull()
            if (last == null || seg.startAt.epochSecond > last.endAt.epochSecond + 60) {
                merged += seg
            } else {
                merged[merged.lastIndex] = last.copy(
                    endAt = if (seg.endAt.isAfter(last.endAt)) seg.endAt else last.endAt,
                )
            }
        }
        return merged
    }

    private fun clusterSleepIntoNights(
        samples: List<SamplePoint>,
        zone: ZoneId,
    ): List<List<SamplePoint>> {
        val sorted = samples.sortedBy { it.endAt }
        val nights = mutableListOf<MutableList<SamplePoint>>()
        var current = mutableListOf<SamplePoint>()
        var latestEnd = 0L

        for (s in sorted) {
            val end = s.endAt.toEpochMilli()
            if (current.isEmpty()) {
                current.add(s)
                latestEnd = end
                continue
            }
            val windowStart = latestEnd - 16L * 60 * 60 * 1000
            if (end in windowStart..latestEnd + 60_000) {
                current.add(s)
                if (end > latestEnd) latestEnd = end
            } else {
                nights += current
                current = mutableListOf(s)
                latestEnd = end
            }
        }
        if (current.isNotEmpty()) nights += current
        return nights
    }

    /** Incrémental : repli 1 sample/nuit (durée totale @ midi). */
    private fun buildSleepSyntheticFromDaily(
        dailyByDay: Map<LocalDate, DailyAggregate>,
        zone: ZoneId,
    ): List<SamplePoint> {
        val out = mutableListOf<SamplePoint>()
        for ((day, row) in dailyByDay) {
            val mins = row.sleepTotalMin ?: continue
            if (mins <= 0) continue
            val start = day.atTime(12, 0).atZone(zone).toInstant()
            val end = start.plusSeconds(mins.toLong() * 60)
            val sample = buildSleepStageSample(
                sourceName = "health_connect",
                sourceId = "health_connect",
                stage = null,
                startAt = start,
                endAt = end,
                parentPlatformId = "sleep|agg|$day",
                segmentKey = "night",
            ) ?: continue
            out += sample
        }
        return out
    }

    private fun instantToLocalDate(instant: Instant, zone: ZoneId): LocalDate =
        instant.atZone(zone).toLocalDate()

    private fun median(vals: List<Double>): Double {
        if (vals.isEmpty()) return 0.0
        val sorted = vals.sorted()
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 0) {
            (sorted[mid - 1] + sorted[mid]) / 2.0
        } else {
            sorted[mid]
        }
    }

    private fun average(vals: List<Double>): Double? {
        if (vals.isEmpty()) return null
        return vals.sum() / vals.size
    }
}
