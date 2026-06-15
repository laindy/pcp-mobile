package com.pcpinnov.pcpttherapy.health

/** Découpe fenêtre historique en tranches — aligné iOS [buildHistoricalSlices]. */
object HistoricalSlicePlanner {

    const val SLICE_DAYS = 10
    const val DAILY_EXTENDED_SLICE_DAYS = 30
    private const val MS_PER_DAY = 24L * 60 * 60 * 1000

    data class Slice(
        val startMs: Long,
        val endMs: Long,
        val sliceIndex: Int,
    )

    fun buildSlices(startMs: Long, endMs: Long, sliceDays: Int = SLICE_DAYS): List<Slice> {
        val slices = mutableListOf<Slice>()
        var sliceEnd = endMs
        var index = 0
        val stepMs = sliceDays * MS_PER_DAY
        while (sliceEnd > startMs) {
            val sliceStart = maxOf(startMs, sliceEnd - stepMs)
            slices += Slice(startMs = sliceStart, endMs = sliceEnd, sliceIndex = index)
            sliceEnd = sliceStart - 1
            index += 1
        }
        return slices
    }

    fun buildDailyExtendedSlices(startMs: Long, endMs: Long): List<Slice> =
        buildSlices(startMs, endMs, DAILY_EXTENDED_SLICE_DAYS)
}
