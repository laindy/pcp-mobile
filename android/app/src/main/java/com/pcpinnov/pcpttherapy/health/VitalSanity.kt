package com.pcpinnov.pcpttherapy.health

/**
 * Filtre optionnel pour agrégats historiques compacts.
 * Affichage / vitals/latest : parité écran Health Connect → [latestChronological].
 */
object VitalSanity {

    fun isPlausible(sample: SamplePoint): Boolean = isPlausible(sample.dataType, sample.value)

    fun isPlausible(dataType: String, value: Double): Boolean = when (dataType) {
        "heartRateVariability" -> value in 5.0..250.0
        "restingHeartRate" -> value in 35.0..120.0
        "respiratoryRate" -> value in 8.0..30.0
        "oxygenSaturation" -> value in 80.0..100.0
        "bodyTemperature" -> value in 35.0..38.5
        else -> true
    }

    /** Dernière mesure HC par horodatage — même logique que la liste HC. */
    fun latestChronological(samples: List<SamplePoint>): SamplePoint? =
        samples.maxByOrNull { it.startAt }

    fun latestPlausible(samples: List<SamplePoint>): SamplePoint? =
        samples.sortedByDescending { it.startAt }.firstOrNull { isPlausible(it) }

}
