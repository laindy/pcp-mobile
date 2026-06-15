package com.pcpinnov.pcpttherapy.health

import android.util.Log
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
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

    /** Vitals bruts sur sync incrémentale / récente — compaction uniquement historique 8–60j. */
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

        for (type in VITAL_COMPACT_TYPES) {
            val raw = samplesByType[type] ?: continue
            if (raw.isEmpty()) continue
            val collapsed = collapseVitalsToDaily(raw, type, zone, useMedian = type == "heartRateVariability")
            if (collapsed.isNotEmpty()) {
                Log.i(TAG, "  $type $label: ${raw.size} bruts → ${collapsed.size} jour(s)")
                samplesByType[type] = collapsed.toMutableList()
            }
        }

        val temps = samplesByType["bodyTemperature"]
        if (!temps.isNullOrEmpty()) {
            val shouldCollapse = isHistoricalLight(phaseLabel) && temps.size > 50
            if (shouldCollapse) {
                val collapsed = collapseVitalsToDaily(temps, "bodyTemperature", zone, useMedian = false)
                if (collapsed.isNotEmpty()) {
                    Log.i(TAG, "  bodyTemperature $label: ${temps.size} bruts → ${collapsed.size} jour(s)")
                    samplesByType["bodyTemperature"] = collapsed.toMutableList()
                }
            }
        }

        val sleepRaw = samplesByType["sleep"] ?: return
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
    ): List<SamplePoint> = collapseVitalsToDaily(
        samples,
        dataType,
        zone,
        useMedian = dataType == "heartRateVariability",
    )

    private fun collapseVitalsToDaily(
        samples: List<SamplePoint>,
        dataType: String,
        zone: ZoneId,
        useMedian: Boolean,
    ): List<SamplePoint> {
        val byDay = samples.groupBy { instantToLocalDate(it.startAt, zone) }
        val out = mutableListOf<SamplePoint>()
        for ((day, list) in byDay) {
            val vals = list.map { it.value }.filter { it.isFinite() && it > 0 }
            if (vals.isEmpty()) continue
            val value = if (useMedian) median(vals) else average(vals) ?: continue
            if (value <= 0) continue
            val noon = day.atTime(12, 0).atZone(zone).toInstant()
            val rounded = round(value * 100.0) / 100.0
            out += SamplePoint(
                dataType = dataType,
                value = rounded,
                unit = list.first().unit,
                startAt = noon,
                endAt = noon,
                sourceId = "health_connect",
                sourceName = "health_connect",
                platformId = "${dataType}|agg|$day|$rounded".take(255),
                origin = list.firstOrNull { it.origin != null }?.origin,
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
