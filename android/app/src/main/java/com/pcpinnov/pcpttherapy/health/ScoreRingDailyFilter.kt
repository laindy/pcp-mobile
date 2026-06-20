package com.pcpinnov.pcpttherapy.health

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * Filtre les agrégats / samples vitaux qui feraient de GET /daily?limit=1 une ligne
 * future ou un aujourd'hui incomplet (vitaux seuls) — anneaux recovery/effort vides.
 */
object ScoreRingDailyFilter {

    private val NIGHT_VITAL_TYPES = setOf(
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
        "bodyTemperature",
        "restingHeartRate",
    )

    fun localToday(zone: ZoneId = ZoneId.systemDefault()): LocalDate = LocalDate.now(zone)

    fun isFutureDay(day: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Boolean =
        day.isAfter(localToday(zone))

    fun isVitalsOnlyPartial(row: DailyAggregate): Boolean {
        val hasActivity = (row.stepsTotal ?: 0L) > 0L || (row.caloriesTotalKcal ?: 0.0) > 0.0
        val hasSleep = (row.sleepTotalMin ?: 0) > 0
        return !hasActivity && !hasSleep
    }

    fun isPostableDailyRow(row: DailyAggregate, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        if (!row.hasAnyValue()) return false
        val today = localToday(zone)
        if (row.day.isAfter(today)) return false
        if (row.day == today && isVitalsOnlyPartial(row)) return false
        return true
    }

    fun filterDailyAggregates(
        rows: Iterable<DailyAggregate>,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<DailyAggregate> = rows.filter { isPostableDailyRow(it, zone) }

    fun wakeDayForVitalSample(sample: SamplePoint, zone: ZoneId): LocalDate {
        parseWakeDayFromPlatformId(sample.platformId)?.let { return it }
        return vitalWakeDay(sample.startAt, zone)
    }

    fun isPostableVitalSample(sample: SamplePoint, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        if (sample.dataType !in NIGHT_VITAL_TYPES) return true
        return !isFutureDay(wakeDayForVitalSample(sample, zone), zone)
    }

    fun filterVitalSamples(
        samples: List<SamplePoint>,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<SamplePoint> = samples.filter { isPostableVitalSample(it, zone) }

    private fun parseWakeDayFromPlatformId(platformId: String): LocalDate? {
        val parts = platformId.split("|")
        if (parts.size < 3 || parts[1] != "agg") return null
        return try {
            LocalDate.parse(parts[2])
        } catch (_: Exception) {
            null
        }
    }

    /** Jour de réveil (UTC heure) — aligné health_service._night_values_by_day. */
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
}
