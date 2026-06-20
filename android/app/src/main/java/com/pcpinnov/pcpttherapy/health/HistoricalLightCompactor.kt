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

    /** Vitaux bruts sur sync incrémentale / récente — compaction uniquement historique 8–60j. */
    fun useVitalCompact(phaseLabel: String): Boolean =
        isHistoricalLight(phaseLabel)

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
        val nightIndex = buildWakeDayNightTimestampIndex(sleepRaw, dailyByDay, zone, isHistoricalLight(phaseLabel))

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

        val compacted = if (isHistoricalLight(phaseLabel)) {
            compactSleepStagedHistorical(sleepRaw, zone)
        } else {
            buildSleepSyntheticFromDaily(dailyByDay, zone)
        }

        if (compacted.isNotEmpty()) {
            val nights = if (isHistoricalLight(phaseLabel)) countSleepNights(sleepRaw, zone) else dailyByDay.size
            Log.i(
                TAG,
                "  sleep ($label): ${sleepRaw.size} bruts → ${compacted.size} segment(s)" +
                    if (isHistoricalLight(phaseLabel)) " ($nights nuit(s))" else " synthétique(s)",
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
                platformId = "${dataType}|agg|$wakeDay|$rounded".take(255),
                origin = list.firstOrNull { it.origin != null }?.origin,
            )
        }
        return out
    }

    private fun vitalWakeDay(instant: Instant, zone: ZoneId): LocalDate {
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
        historicalLight: Boolean,
    ): Map<LocalDate, Instant> {
        val staged = if (historicalLight) {
            compactSleepStagedHistorical(sleepRaw, zone)
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

    /**
     * 1 segment sommeil par jour de réveil des vitaux réparés — attribution nocturne backend.
     */
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
            out += SamplePoint(
                dataType = "sleep",
                value = mins,
                unit = "minute",
                startAt = startAt,
                endAt = endAt,
                sourceName = "healthkit",
                platformId = "sleep|companion|$wakeDay".take(255),
                stage = "asleep",
            )
        }
        return out
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
            val wakeDay = nightSamples.maxOfOrNull { instantToLocalDate(it.endAt, zone) } ?: continue
            val byStage = nightSamples.groupBy { it.stage!! }

            for ((stage, segs) in byStage) {
                val merged = mergeAdjacentSegments(segs)
                merged.forEachIndexed { idx, seg ->
                    val mins = (seg.endAt.epochSecond - seg.startAt.epochSecond) / 60.0
                    if (mins <= 0) return@forEachIndexed
                    val pid = "sleep|hist|$wakeDay|$stage|$idx".take(255)
                    out += SamplePoint(
                        dataType = "sleep",
                        value = mins,
                        unit = "minute",
                        startAt = seg.startAt,
                        endAt = seg.endAt,
                        sourceId = seg.sourceId,
                        sourceName = seg.sourceName,
                        platformId = pid,
                        stage = stage,
                    )
                }
            }
        }
        return out
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

    private fun countSleepNights(samples: List<SamplePoint>, zone: ZoneId): Int =
        clusterSleepIntoNights(samples.filter { !it.stage.isNullOrBlank() }, zone).size

    /** Incrémental : 1 sample/nuit (durée totale @ midi). */
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
            out += SamplePoint(
                dataType = "sleep",
                value = mins.toDouble(),
                unit = "minute",
                startAt = start,
                endAt = end,
                sourceId = "health_connect",
                sourceName = "health_connect",
                platformId = "sleep|agg|$day|$mins".take(255),
            )
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
