package com.pcpinnov.pcpttherapy.health

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Attribue le sommeil à la journée de réveil (parité écran Health Connect)
 * en ne comptant que les stades endormis — pas inBed/awake.
 */
object SleepNightAttribution {

    private val ASLEEP_STAGE_MARKERS = setOf(
        "stage_type_light",
        "stage_type_deep",
        "stage_type_rem",
        "stage_type_sleeping",
        "asleep",
        "light",
        "deep",
        "rem",
        "sleeping",
    )

    private val EXCLUDED_STAGE_MARKERS = setOf(
        "stage_type_awake",
        "stage_type_awake_in_bed",
        "stage_type_out_of_bed",
        "stage_type_in_bed",
        "inbed",
        "in_bed",
        "awake",
        "outofbed",
        "out_of_bed",
    )

    fun isAsleepStage(stage: String?): Boolean {
        if (stage.isNullOrBlank()) return true
        val norm = stage.lowercase().replace("_", "")
        if (EXCLUDED_STAGE_MARKERS.any { norm.contains(it.replace("_", "")) }) return false
        if (ASLEEP_STAGE_MARKERS.any { norm.contains(it.replace("_", "")) }) return true
        return norm.contains("asleep") || norm.contains("sleep")
    }

    /** Minutes endormies par jour de réveil. */
    fun minutesByWakeDay(
        sleepSamples: List<SamplePoint>,
        zone: ZoneId,
    ): Map<LocalDate, Int> {
        val staged = sleepSamples.filter { !it.stage.isNullOrBlank() }
        if (staged.isNotEmpty()) {
            return minutesByWakeDayFromStages(staged, zone)
        }
        return minutesByWakeDayFromSessions(sleepSamples, zone)
    }

    /** Dernière nuit complétée (session la plus récente). */
    fun lastNightSleepMinutes(
        sleepSamples: List<SamplePoint>,
        zone: ZoneId,
        now: Instant = Instant.now(),
    ): Int? {
        val staged = sleepSamples.filter { !it.stage.isNullOrBlank() }
        val nights = if (staged.isNotEmpty()) {
            clusterIntoNights(staged, zone)
        } else {
            clusterIntoNights(sleepSamples, zone)
        }
        if (nights.isEmpty()) return null
        val recentCutoff = now.toEpochMilli() - 36L * 60 * 60 * 1000
        val recent = nights.filter { night ->
            night.maxOfOrNull { it.endAt.toEpochMilli() } ?: 0L >= recentCutoff
        }
        val pick = (if (recent.isNotEmpty()) recent else nights)
            .maxByOrNull { night -> night.maxOfOrNull { it.endAt.toEpochMilli() } ?: 0L }
            ?: return null
        return nightAsleepMinutes(pick)
    }

    fun applyWakeDayTotals(
        dailyByDay: MutableMap<LocalDate, DailyAggregate>,
        sleepSamples: List<SamplePoint>,
        zone: ZoneId,
    ) {
        val byWake = minutesByWakeDay(sleepSamples, zone)
        byWake.forEach { (day, mins) ->
            if (mins > 0) {
                daily(day, dailyByDay).sleepTotalMin = mins
            }
        }
    }

    private fun minutesByWakeDayFromStages(
        staged: List<SamplePoint>,
        zone: ZoneId,
    ): Map<LocalDate, Int> {
        val out = mutableMapOf<LocalDate, Int>()
        for (night in clusterIntoNights(staged, zone)) {
            val wakeDay = night.maxOfOrNull { instantToLocalDate(it.endAt, zone) } ?: continue
            val mins = nightAsleepMinutes(night)
            if (mins > 0) {
                out[wakeDay] = (out[wakeDay] ?: 0) + mins
            }
        }
        return out
    }

    private fun minutesByWakeDayFromSessions(
        sessions: List<SamplePoint>,
        zone: ZoneId,
    ): Map<LocalDate, Int> {
        val out = mutableMapOf<LocalDate, Int>()
        for (night in clusterIntoNights(sessions, zone)) {
            val wakeDay = night.maxOfOrNull { instantToLocalDate(it.endAt, zone) } ?: continue
            val mins = night.sumOf { it.value.toInt().coerceAtLeast(0) }
            if (mins > 0) {
                out[wakeDay] = (out[wakeDay] ?: 0) + mins
            }
        }
        return out
    }

    private fun nightAsleepMinutes(night: List<SamplePoint>): Int {
        var total = 0.0
        for (s in night) {
            if (!isAsleepStage(s.stage)) continue
            total += s.value
        }
        return total.toInt().coerceAtLeast(0)
    }

    private fun clusterIntoNights(
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

    private fun instantToLocalDate(instant: Instant, zone: ZoneId): LocalDate =
        instant.atZone(zone).toLocalDate()

    private fun daily(day: LocalDate, map: MutableMap<LocalDate, DailyAggregate>): DailyAggregate =
        map.getOrPut(day) { DailyAggregate(day) }
}
