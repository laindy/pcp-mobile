package com.pcpinnov.pcpttherapy.health

import android.util.Log
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * Pipeline collecte HC → POST par lots — parité iOS [collectAndStreamPost].
 * Lecture parallèle (5 types) + envoi scoring (pas/calories) dès que prêt.
 */
object HealthSyncStreaming {

    private const val TAG = "HealthSyncStream"
    private const val READ_CONCURRENCY = 5
    private const val CHUNK_READ_CONCURRENCY = 4
    private const val DATE_CHUNK_DAYS = 10
    private const val MS_PER_DAY = 24L * 60 * 60 * 1000

    private const val MAX_SYNC_POST_BYTES = 512 * 1024
    private const val MAX_DENSE_POST_BYTES = 380 * 1024
    private const val MAX_DENSE_SAMPLES = 2500

    private val DENSE_STREAM_TYPES = setOf(
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
        "sleep",
    )

    private val DATE_CHUNK_TYPES = setOf(
        "heartRateVariability",
        "respiratoryRate",
        "oxygenSaturation",
    )

    data class StreamResult(
        val outcome: HealthSyncExecutor.Outcome,
        val totalInserted: Int,
        val totalAggregates: Int,
        val totalSamples: Int,
        val anyData: Boolean,
    )

    suspend fun runPhase(
        repository: HealthSyncRepository,
        store: TokenStore,
        token: String,
        phase: TokenStore.SyncPhase,
        includeDailyAggregates: Boolean,
        post: (HealthSyncExecutor.PostResult) -> HealthSyncExecutor.Outcome?,
    ): StreamResult {
        val syncStarted = System.currentTimeMillis()
        var totalInserted = 0
        var totalAggregates = 0
        var totalSamples = 0
        var anyData = false
        var firstPostLogged = false

        val start = Instant.ofEpochMilli(phase.startMs)
        val end = Instant.ofEpochMilli(phase.endMs)
        val phaseLabel = phase.label
        val historicalLight = HistoricalLightCompactor.isHistoricalLight(phaseLabel)
        val incrementalCompact = HistoricalLightCompactor.isIncrementalCompact(phaseLabel)
        val deferPosts = historicalLight

        val ctx = repository.beginCollectContext()
        Log.i(
            TAG,
            "Pipeline ($phaseLabel) — lecture ∥$READ_CONCURRENCY" +
                when {
                    historicalLight -> ", historique léger"
                    incrementalCompact -> ", incrémental compact"
                    else -> ", POST streaming"
                },
        )

        repository.readDailyAggregates(ctx, start, end)

        val sleepPreRead = repository.readSampleType(ctx, "sleep", start, end)
        SleepNightAttribution.applyWakeDayTotals(ctx.dailyByDay, sleepPreRead, ZoneId.systemDefault())
        val nightIndex = HistoricalLightCompactor.buildWakeDayNightTimestampIndex(
            sleepPreRead,
            ctx.dailyByDay,
            ZoneId.systemDefault(),
            phaseLabel,
        )

        val scoring = repository.buildScoringSamples(ctx.dailyByDay, nightIndex)
        val earlyOverlay = ScoreRingDailyFilter.filterDailyAggregates(
            ctx.dailyByDay.values.filter { it.hasActivitySignal() },
        ).sortedBy { it.day }

        if (!deferPosts) {
            for (type in listOf("steps", "calories", "restingHeartRate")) {
                val samples = scoring[type] ?: continue
                if (samples.isEmpty()) continue
                val payload = repository.buildPartialPayload(
                    ctx, start, end, mapOf(type to samples), emptyList(), earlyOverlay,
                )
                when (val r = postTypeBlock(store, token, payload, phaseLabel, type, earlyOverlay, post)) {
                    is BlockPost.Ok -> {
                        totalInserted += r.samplesInserted
                        totalAggregates += r.aggregatesInserted
                        totalSamples += samples.size
                        anyData = true
                        if (!firstPostLogged) {
                            firstPostLogged = true
                            val elapsed = (System.currentTimeMillis() - syncStarted) / 1000
                            Log.i(TAG, "Premier lot envoyé en ${elapsed}s ($type)")
                        }
                    }
                    is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
                }
            }
        }

        val sampleTypes = buildList {
            if (!incrementalCompact) add("restingHeartRate")
            add("heartRateVariability")
            add("respiratoryRate")
            add("oxygenSaturation")
            add("bodyTemperature")
            add("vo2Max")
            // sleep lu une fois (nightIndex) — pas de 2e lecture HC
        }

        val semaphore = Semaphore(READ_CONCURRENCY)
        val typeSamples = coroutineScope {
            sampleTypes.map { type ->
                async {
                    semaphore.withPermit {
                        readTypeSamples(repository, ctx, type, start, end, phaseLabel, historicalLight)
                    }
                }
            }.awaitAll()
        }.toMap()

        val workouts = repository.readWorkouts(ctx, start, end)
        val hrWorkout = repository.readWorkoutHeartRates(ctx, workouts)

        val merged = mutableMapOf<String, MutableList<SamplePoint>>()
        scoring.forEach { (k, v) -> if (v.isNotEmpty()) merged[k] = v.toMutableList() }
        typeSamples.forEach { (type, list) ->
            if (list.isNotEmpty()) merged.getOrPut(type) { mutableListOf() }.addAll(list)
        }
        if (sleepPreRead.isNotEmpty()) merged["sleep"] = sleepPreRead.toMutableList()
        if (hrWorkout.isNotEmpty()) merged["heartRate"] = hrWorkout.toMutableList()

        repository.finalizeSamples(ctx, merged, phaseLabel)

        val dailyOverlay = ScoreRingDailyFilter.filterDailyAggregates(
            ctx.dailyByDay.values.filter { it.hasAnyValue() },
        ).sortedBy { it.day }

        val postOrder = merged.keys.toList() + listOf("workouts")
        for (type in postOrder) {
            when (type) {
                "workouts" -> {
                    if (workouts.isEmpty()) continue
                    val payload = repository.buildPartialPayload(
                        ctx, start, end, merged, workouts, dailyOverlay,
                    )
                    when (val r = postWorkouts(store, token, payload, phaseLabel, dailyOverlay, post)) {
                        is BlockPost.Ok -> {
                            totalInserted += r.samplesInserted
                            totalAggregates += r.aggregatesInserted
                            anyData = true
                        }
                        is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
                    }
                }
                else -> {
                    val samples = merged[type] ?: continue
                    if (samples.isEmpty()) continue
                    totalSamples += samples.size
                    anyData = true
                    val payload = repository.buildPartialPayload(
                        ctx, start, end, mapOf(type to samples), emptyList(), dailyOverlay,
                    )
                    when (val r = postTypeBlock(store, token, payload, phaseLabel, type, dailyOverlay, post)) {
                        is BlockPost.Ok -> {
                            totalInserted += r.samplesInserted
                            totalAggregates += r.aggregatesInserted
                            if (!firstPostLogged) {
                                firstPostLogged = true
                                val elapsed = (System.currentTimeMillis() - syncStarted) / 1000
                                Log.i(TAG, "Premier lot envoyé en ${elapsed}s ($type)")
                            }
                        }
                        is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
                    }
                }
            }
        }

        if (dailyOverlay.isNotEmpty()) {
            val aggPayload = repository.buildPartialPayload(
                ctx, start, end, emptyMap(), emptyList(), dailyOverlay,
            )
            when (val r = postAggregatesOnly(store, token, aggPayload, phaseLabel, post)) {
                is BlockPost.Ok -> {
                    totalAggregates += r.aggregatesInserted
                    anyData = anyData || r.aggregatesInserted > 0
                }
                is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
            }
        }

        return StreamResult(HealthSyncExecutor.Outcome.SUCCESS, totalInserted, totalAggregates, totalSamples, anyData)
    }

    /** J 61–365 : agrégats journaliers + workouts + VO₂ (pas d'intraday vitaux/sommeil). */
    suspend fun runDailyExtendedPhase(
        repository: HealthSyncRepository,
        store: TokenStore,
        token: String,
        phase: TokenStore.SyncPhase,
        post: (HealthSyncExecutor.PostResult) -> HealthSyncExecutor.Outcome?,
    ): StreamResult {
        var totalInserted = 0
        var totalAggregates = 0
        var totalSamples = 0
        var anyData = false

        val start = Instant.ofEpochMilli(phase.startMs)
        val end = Instant.ofEpochMilli(phase.endMs)
        val phaseLabel = phase.label
        val ctx = repository.beginCollectContext()
        Log.i(TAG, "Pipeline daily-extended ($phaseLabel) — agrégats + sommeil + vitaux + workouts")

        repository.readDailyAggregates(ctx, start, end)
        repository.enrichDailyWithSleep(ctx, start, end)
        val sleepRaw = repository.readSampleType(ctx, "sleep", start, end)
        val nightIndex = HistoricalLightCompactor.buildWakeDayNightTimestampIndex(
            sleepRaw,
            ctx.dailyByDay,
            ZoneId.systemDefault(),
            phaseLabel = "daily-extended",
        )
        val vitalSamples = repository.readDailyExtendedVitalsCompact(ctx, start, end)
        val scoring = repository.buildScoringSamples(ctx.dailyByDay, nightIndex)
        val dailyOverlay = ScoreRingDailyFilter.filterDailyAggregates(
            ctx.dailyByDay.values.filter { it.hasAnyValue() },
        ).sortedBy { it.day }

        for (type in listOf("steps", "calories", "restingHeartRate")) {
            val samples = scoring[type] ?: continue
            if (samples.isEmpty()) continue
            val payload = repository.buildPartialPayload(
                ctx, start, end, mapOf(type to samples), emptyList(), dailyOverlay,
            )
            when (val r = postTypeBlock(store, token, payload, "$phaseLabel|$type", dailyOverlay, post)) {
                is BlockPost.Ok -> {
                    totalInserted += r.samplesInserted
                    totalAggregates += r.aggregatesInserted
                    totalSamples += samples.size
                    anyData = true
                }
                is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
            }
        }

        for ((type, samples) in vitalSamples) {
            if (samples.isEmpty()) continue
            val payload = repository.buildPartialPayload(
                ctx, start, end, mapOf(type to samples), emptyList(), dailyOverlay,
            )
            when (val r = postTypeBlock(store, token, payload, "$phaseLabel|$type", dailyOverlay, post)) {
                is BlockPost.Ok -> {
                    totalInserted += r.samplesInserted
                    totalAggregates += r.aggregatesInserted
                    totalSamples += samples.size
                    anyData = true
                }
                is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
            }
        }

        val vo2 = repository.readSampleType(ctx, "vo2Max", start, end)
        if (vo2.isNotEmpty()) {
            val payload = repository.buildPartialPayload(
                ctx, start, end, mapOf("vo2Max" to vo2), emptyList(), dailyOverlay,
            )
            when (val r = postTypeBlock(store, token, payload, "$phaseLabel|vo2Max", dailyOverlay, post)) {
                is BlockPost.Ok -> {
                    totalInserted += r.samplesInserted
                    totalAggregates += r.aggregatesInserted
                    totalSamples += vo2.size
                    anyData = true
                }
                is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
            }
        }

        val workouts = repository.readWorkouts(ctx, start, end)
        if (workouts.isNotEmpty()) {
            val payload = repository.buildPartialPayload(
                ctx, start, end, emptyMap(), workouts, dailyOverlay,
            )
            when (val r = postWorkouts(store, token, payload, phaseLabel, dailyOverlay, post)) {
                is BlockPost.Ok -> {
                    totalInserted += r.samplesInserted
                    totalAggregates += r.aggregatesInserted
                    anyData = true
                }
                is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
            }
        }

        if (dailyOverlay.isNotEmpty()) {
            val aggPayload = repository.buildPartialPayload(
                ctx, start, end, emptyMap(), emptyList(), dailyOverlay,
            )
            when (val r = postAggregatesOnly(store, token, aggPayload, phaseLabel, post)) {
                is BlockPost.Ok -> {
                    totalAggregates += r.aggregatesInserted
                    anyData = anyData || r.aggregatesInserted > 0
                }
                is BlockPost.Fail -> return StreamResult(r.outcome, totalInserted, totalAggregates, totalSamples, anyData)
            }
        }

        return StreamResult(HealthSyncExecutor.Outcome.SUCCESS, totalInserted, totalAggregates, totalSamples, anyData)
    }

    private suspend fun readTypeSamples(
        repository: HealthSyncRepository,
        ctx: HealthSyncRepository.CollectContext,
        type: String,
        start: Instant,
        end: Instant,
        phaseLabel: String,
        historicalLight: Boolean,
    ): Pair<String, List<SamplePoint>> {
        val windowDays = ((end.toEpochMilli() - start.toEpochMilli()) / MS_PER_DAY).toInt().coerceAtLeast(1)
        val useChunks = type in DATE_CHUNK_TYPES && windowDays > DATE_CHUNK_DAYS && !historicalLight
        val samples = if (useChunks) {
            val ranges = buildDateChunkRanges(start.toEpochMilli(), end.toEpochMilli())
            val sem = Semaphore(CHUNK_READ_CONCURRENCY)
            coroutineScope {
                ranges.map { range ->
                    async {
                        sem.withPermit {
                            repository.readSampleType(
                                ctx,
                                type,
                                Instant.ofEpochMilli(range.first),
                                Instant.ofEpochMilli(range.second),
                            )
                        }
                    }
                }.awaitAll().flatten()
            }
        } else {
            repository.readSampleType(ctx, type, start, end)
        }
        return type to samples
    }

    private fun buildDateChunkRanges(startMs: Long, endMs: Long): List<Pair<Long, Long>> {
        val ranges = mutableListOf<Pair<Long, Long>>()
        var chunkEnd = endMs
        while (chunkEnd > startMs) {
            val chunkStart = maxOf(startMs, chunkEnd - DATE_CHUNK_DAYS * MS_PER_DAY)
            ranges += chunkStart to chunkEnd
            chunkEnd = chunkStart - 1
        }
        return ranges
    }

    private sealed class BlockPost {
        data class Ok(val samplesInserted: Int, val aggregatesInserted: Int) : BlockPost()
        data class Fail(val outcome: HealthSyncExecutor.Outcome) : BlockPost()
    }

    private fun postTypeBlock(
        store: TokenStore,
        token: String,
        basePayload: SyncPayload,
        phaseLabel: String,
        type: String,
        overlay: List<DailyAggregate>,
        post: (HealthSyncExecutor.PostResult) -> HealthSyncExecutor.Outcome?,
    ): BlockPost {
        val samples = basePayload.samplesByType[type] ?: return BlockPost.Ok(0, 0)
        val chunks = splitSamplesIntoChunks(type, samples, overlay)
        var inserted = 0
        var aggregates = 0
        for ((i, chunk) in chunks.withIndex()) {
            val label = if (chunks.size > 1) "$phaseLabel|$type#${i + 1}" else "$phaseLabel|$type"
            val partial = basePayload.copy(
                samplesByType = mapOf(type to chunk),
                dailyAggregates = overlay,
            )
            val body = HealthSyncPayloadBuilder.build(
                payload = partial,
                syncId = UUID.randomUUID(),
                phaseLabel = label,
                includeDailyAggregates = overlay.isNotEmpty(),
            )
            val result = HealthSyncExecutor.postSyncPublic(store, HealthSyncExecutor.httpClient, body)
            when (result) {
                is HealthSyncExecutor.PostResult.Success -> {
                    inserted += result.samplesInserted
                    aggregates += result.aggregatesInserted
                }
                else -> {
                    val outcome = post(result) ?: HealthSyncExecutor.Outcome.TERMINAL
                    return BlockPost.Fail(outcome)
                }
            }
        }
        return BlockPost.Ok(inserted, aggregates)
    }

    private fun postWorkouts(
        store: TokenStore,
        token: String,
        basePayload: SyncPayload,
        phaseLabel: String,
        overlay: List<DailyAggregate>,
        post: (HealthSyncExecutor.PostResult) -> HealthSyncExecutor.Outcome?,
    ): BlockPost {
        if (basePayload.workouts.isEmpty()) return BlockPost.Ok(0, 0)
        val partial = basePayload.copy(dailyAggregates = overlay)
        val body = HealthSyncPayloadBuilder.build(
            payload = partial,
            syncId = UUID.randomUUID(),
            phaseLabel = "$phaseLabel|workouts",
            includeDailyAggregates = overlay.isNotEmpty(),
        )
        val result = HealthSyncExecutor.postSyncPublic(store, HealthSyncExecutor.httpClient, body)
        return when (result) {
            is HealthSyncExecutor.PostResult.Success ->
                BlockPost.Ok(result.samplesInserted, result.aggregatesInserted)
            else -> BlockPost.Fail(post(result) ?: HealthSyncExecutor.Outcome.TERMINAL)
        }
    }

    private fun postAggregatesOnly(
        store: TokenStore,
        token: String,
        basePayload: SyncPayload,
        phaseLabel: String,
        post: (HealthSyncExecutor.PostResult) -> HealthSyncExecutor.Outcome?,
    ): BlockPost {
        val partial = basePayload.copy(samplesByType = emptyMap(), workouts = emptyList())
        val body = HealthSyncPayloadBuilder.build(
            payload = partial,
            syncId = UUID.randomUUID(),
            phaseLabel = "$phaseLabel|aggregates",
            includeDailyAggregates = true,
        )
        val result = HealthSyncExecutor.postSyncPublic(store, HealthSyncExecutor.httpClient, body)
        return when (result) {
            is HealthSyncExecutor.PostResult.Success ->
                BlockPost.Ok(result.samplesInserted, result.aggregatesInserted)
            else -> BlockPost.Fail(post(result) ?: HealthSyncExecutor.Outcome.TERMINAL)
        }
    }

    fun splitSamplesIntoChunks(
        type: String,
        samples: List<SamplePoint>,
        overlay: List<DailyAggregate>,
    ): List<List<SamplePoint>> {
        if (samples.isEmpty()) return emptyList()
        val maxBytes = if (type in DENSE_STREAM_TYPES) MAX_DENSE_POST_BYTES else MAX_SYNC_POST_BYTES
        val maxSamples = if (type in DENSE_STREAM_TYPES) MAX_DENSE_SAMPLES else samples.size

        val chunks = mutableListOf<List<SamplePoint>>()
        var batch = mutableListOf<SamplePoint>()
        for (sample in samples) {
            batch.add(sample)
            if (batch.size >= maxSamples || estimateChunkBytes(type, batch, overlay) > maxBytes) {
                if (batch.size > 1 && estimateChunkBytes(type, batch, overlay) > maxBytes) {
                    val tail = batch.removeAt(batch.lastIndex)
                    chunks += batch.toList()
                    batch = mutableListOf(tail)
                } else if (batch.size >= maxSamples) {
                    chunks += batch.toList()
                    batch = mutableListOf()
                }
            }
        }
        if (batch.isNotEmpty()) chunks += batch
        return if (chunks.isEmpty()) listOf(samples) else chunks
    }

    private fun estimateChunkBytes(
        type: String,
        samples: List<SamplePoint>,
        overlay: List<DailyAggregate>,
    ): Int {
        val payload = SyncPayload(
            windowStart = Instant.EPOCH,
            windowEnd = Instant.EPOCH,
            grantedDataTypes = emptyList(),
            deniedDataTypes = emptyList(),
            errors = emptyMap(),
            samplesByType = mapOf(type to samples),
            dailyAggregates = overlay,
        )
        return HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "estimate",
            includeDailyAggregates = overlay.isNotEmpty(),
        ).toString().length
    }
}

private fun DailyAggregate.hasActivitySignal(): Boolean =
    (stepsTotal ?: 0L) > 0L || (caloriesTotalKcal ?: 0.0) > 0.0
