package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Orchestre collecte HC → POST backend. Phases récentes d'abord, historique en arrière-plan (swipe).
 */
object HealthSyncExecutor {

    private const val TAG = "HealthSyncExecutor"
    private const val RECOMPUTE_DAYS_DEFAULT = 90
    private const val MAX_POST_BYTES = 450_000
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    private val backfillRunning = AtomicBoolean(false)

    enum class Outcome {
        SUCCESS,
        RETRY,
        TERMINAL,
    }

    sealed class PostResult {
        data class Success(val samplesInserted: Int, val aggregatesInserted: Int) : PostResult()
        data class AuthFailure(val code: Int) : PostResult()
        data class ClientError(val code: Int, val message: String) : PostResult()
        data class ServerError(val code: Int, val message: String) : PostResult()
        data class NetworkError(val message: String) : PostResult()
    }

    val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(90, TimeUnit.SECONDS)
            .build()
    }

    private val http: OkHttpClient
        get() = httpClient

    fun isBackfillRunning(): Boolean = backfillRunning.get()

    fun postSyncPublic(store: TokenStore, httpClient: OkHttpClient, body: JSONObject): PostResult {
        val token = store.getToken() ?: return PostResult.AuthFailure(401)
        return postSync(store, token, body, httpClient)
    }

    suspend fun run(
        context: Context,
        foreground: Boolean,
        forceFullLookback: Boolean = false,
    ): Outcome = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        val store = TokenStore(app)
        val now = System.currentTimeMillis()
        store.setSyncAttemptStarted(now)
        store.reconcileBackfillState()

        val token = store.getToken()
        if (token.isNullOrBlank()) {
            Log.w(TAG, "Pas de token — sync ignorée")
            return@withContext Outcome.TERMINAL
        }

        if (HealthConnectClient.getSdkStatus(app) != HealthConnectClient.SDK_AVAILABLE) {
            store.setLastSyncError("Health Connect indisponible")
            return@withContext Outcome.TERMINAL
        }

        if (HealthConnectAuthHelper.countGrantedSync(app) == 0) {
            Log.i(TAG, "Sync ignorée — aucune permission lecture Health Connect")
            store.setLastSyncEmpty(now, "health_connect_read_permission_missing")
            return@withContext Outcome.TERMINAL
        }

        if (!foreground && !hasBackgroundReadPermission(app)) {
            Log.i(TAG, "Sync background ignorée — permission READ_HEALTH_DATA_IN_BACKGROUND absente")
            store.setLastSyncEmpty(now, "background_read_permission_missing")
            return@withContext Outcome.TERMINAL
        }

        val repository = HealthSyncRepository(app)

        try {
            StepsRepairExecutor.maybeRun(app, store, repository, http)
        } catch (e: Exception) {
            Log.w(TAG, "Steps repair: ${e.message}")
        }

        try {
            SleepStagesRepairExecutor.maybeRun(app, store, repository, http)
        } catch (e: Exception) {
            Log.w(TAG, "Sleep stages repair: ${e.message}")
        }

        try {
            ServerBackfillProbe.tryMarkComplete(store, http)
        } catch (e: Exception) {
            Log.w(TAG, "Probe serveur: ${e.message}")
        }
        store.reconcileBackfillState()

        val allPhases = store.resolveSyncPhases(now, forceFullLookback)
        val foregroundPhases = allPhases.filter { it.label != "historical" && it.label != "daily-extended" }
        val historicalPhases = allPhases.filter { it.label == "historical" || it.label == "daily-extended" }
        val deferHistorical = foreground && foregroundPhases.isNotEmpty() && historicalPhases.isNotEmpty()

        val phasesNow = if (deferHistorical) foregroundPhases else allPhases
        Log.i(
            TAG,
            "Sync (${if (foreground) "foreground" else "background"}) — ${phasesNow.size} phase(s) maintenant" +
                if (deferHistorical) ", ${historicalPhases.size} historical différé(s)" else "",
        )

        val runResult = runPhases(app, store, token, repository, phasesNow, completeBackfill = !deferHistorical)
        if (runResult.outcome != Outcome.SUCCESS) {
            return@withContext runResult.outcome
        }

        if (deferHistorical) {
            store.setBackfillPending(true)
            store.setLastSync(
                epochMillis = now,
                samplesInserted = runResult.totalInserted,
                aggregatesInserted = runResult.totalAggregates,
                message = "Données récentes OK — historique en arrière-plan",
            )
            HealthBridge.notifyJsBackfillStarted()
            BackgroundHistoricalSync.enqueue(app, historicalPhases)
            return@withContext Outcome.SUCCESS
        }

        if (!runResult.anyData) {
            store.setLastSyncEmpty(now, "no_health_data")
        } else {
            store.setLastSync(
                epochMillis = now,
                samplesInserted = runResult.totalInserted,
                aggregatesInserted = runResult.totalAggregates,
                message = buildSyncSummaryMessage(runResult),
            )
        }

        runPostSyncRepairs(app, store, repository)
        try {
            val recompute = postRecomputeScores(store, token, RECOMPUTE_DAYS_DEFAULT, http)
            when (recompute) {
                is PostResult.Success -> HealthBridge.logToJs("RECOMPUTE_SCORES ok days=$RECOMPUTE_DAYS_DEFAULT")
                is PostResult.AuthFailure -> HealthBridge.logToJs("RECOMPUTE_SCORES auth_${recompute.code}")
                is PostResult.ClientError -> HealthBridge.logToJs("RECOMPUTE_SCORES http_${recompute.code}")
                is PostResult.ServerError -> HealthBridge.logToJs("RECOMPUTE_SCORES http_${recompute.code}")
                is PostResult.NetworkError -> HealthBridge.logToJs("RECOMPUTE_SCORES network ${recompute.message}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Recompute scores: ${e.message}")
            HealthBridge.logToJs("RECOMPUTE_SCORES échec: ${e.message}")
        }

        Outcome.SUCCESS
    }

    private suspend fun runPostSyncRepairs(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
    ) {
        try {
            VitalsResyncExecutor.maybeRun(context, store, repository, http)
        } catch (e: Exception) {
            Log.w(TAG, "Vitals daily repair: ${e.message}")
            HealthBridge.logToJs("VITALS_DAILY_REPAIR échec: ${e.message}")
        }
        try {
            if (SleepDailyRepairExecutor.maybeRun(context, store, repository, http)) {
                HealthBridge.logToJs("SLEEP_DAILY_REPAIR ok (wake-day)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Sleep daily repair: ${e.message}")
            HealthBridge.logToJs("SLEEP_DAILY_REPAIR échec: ${e.message}")
        }
        try {
            RecoveryRescoreExecutor.maybeRun(context, store, repository, http)
        } catch (e: Exception) {
            Log.w(TAG, "Recovery rescore repair: ${e.message}")
            HealthBridge.logToJs("RECOVERY_RESCORE_REPAIR échec: ${e.message}")
        }
    }

    suspend fun runHistoricalPhases(
        context: Context,
        phases: List<TokenStore.SyncPhase>,
    ): Outcome = withContext(Dispatchers.IO) {
        if (!backfillRunning.compareAndSet(false, true)) {
            Log.i(TAG, "Backfill historique déjà en cours")
            return@withContext Outcome.TERMINAL
        }
        var outcome = Outcome.TERMINAL
        var finishReason: String? = null
        try {
            HealthBridge.notifyJsBackfillStarted()
            val app = context.applicationContext
            val store = TokenStore(app)
            val token = store.getToken()
            if (token.isNullOrBlank()) {
                finishReason = "no_token"
                outcome = Outcome.TERMINAL
                return@withContext outcome
            }

            try {
                val skip = ServerBackfillProbe.tryMarkComplete(store, http)
                if (skip.applied) {
                    store.setBackfillPending(false)
                    Log.i(TAG, "Backfill arrière-plan annulé — serveur déjà à jour")
                    val repository = HealthSyncRepository(app)
                    runPostSyncRepairs(app, store, repository)
                    val recompute = postRecomputeScores(store, token, RECOMPUTE_DAYS_DEFAULT, http)
                    if (recompute is PostResult.Success) {
                        HealthBridge.logToJs("RECOMPUTE_SCORES ok days=$RECOMPUTE_DAYS_DEFAULT")
                    }
                    outcome = Outcome.SUCCESS
                    finishReason = "server_skip"
                    return@withContext outcome
                }
            } catch (e: Exception) {
                Log.w(TAG, "Probe backfill arrière-plan: ${e.message}")
            }

            val repository = HealthSyncRepository(app)
            val result = runPhases(app, store, token, repository, phases, completeBackfill = true)
            if (result.outcome == Outcome.SUCCESS) {
                store.setBackfillPending(false)
                runPostSyncRepairs(app, store, repository)
                val recompute = postRecomputeScores(store, token, RECOMPUTE_DAYS_DEFAULT, http)
                if (recompute is PostResult.Success) {
                    HealthBridge.logToJs("RECOMPUTE_SCORES ok days=$RECOMPUTE_DAYS_DEFAULT")
                }
            }
            outcome = result.outcome
            if (outcome != Outcome.SUCCESS) {
                finishReason = outcome.name.lowercase()
            }
            outcome
        } finally {
            backfillRunning.set(false)
            HealthBridge.notifyJsBackfillFinished(outcome == Outcome.SUCCESS, finishReason)
        }
    }

    private data class PhaseRunAggregate(
        val outcome: Outcome,
        val totalInserted: Int,
        val totalAggregates: Int,
        val totalSamples: Int,
        val anyData: Boolean,
    )

    private suspend fun runPhases(
        context: Context,
        store: TokenStore,
        token: String,
        repository: HealthSyncRepository,
        phases: List<TokenStore.SyncPhase>,
        completeBackfill: Boolean,
    ): PhaseRunAggregate {
        var totalInserted = 0
        var totalAggregates = 0
        var totalSamples = 0
        var anyData = false
        var ranHistorical = false

        for ((index, phase) in phases.withIndex()) {
            if (phase.label == "historical" || phase.label == "bg-historical") {
                ranHistorical = true
                val hist = runHistoricalWithCheckpoints(store, token, repository, phase)
                if (hist.outcome != Outcome.SUCCESS) {
                    return PhaseRunAggregate(hist.outcome, totalInserted, totalAggregates, totalSamples, anyData)
                }
                totalInserted += hist.inserted
                totalAggregates += hist.aggregates
                totalSamples += hist.samples
                anyData = anyData || hist.samples > 0
                continue
            }

            if (phase.label == "daily-extended" || phase.label == "bg-daily-extended") {
                ranHistorical = true
                val ext = runDailyExtendedWithCheckpoints(store, token, repository, phase)
                if (ext.outcome != Outcome.SUCCESS) {
                    return PhaseRunAggregate(ext.outcome, totalInserted, totalAggregates, totalSamples, anyData)
                }
                totalInserted += ext.inserted
                totalAggregates += ext.aggregates
                totalSamples += ext.samples
                anyData = anyData || ext.aggregates > 0
                continue
            }

            val streamResult = try {
                HealthSyncStreaming.runPhase(
                    repository = repository,
                    store = store,
                    token = token,
                    phase = phase,
                    includeDailyAggregates = index == phases.lastIndex,
                ) { postResult -> mapPostFailure(store, postResult) }
            } catch (e: Exception) {
                Log.e(TAG, "Stream ${phase.label} échoué: ${e.message}", e)
                store.setLastSyncError("collect_${phase.label}: ${e.message}")
                return PhaseRunAggregate(Outcome.RETRY, totalInserted, totalAggregates, totalSamples, anyData)
            }

            if (streamResult.outcome != Outcome.SUCCESS) {
                return PhaseRunAggregate(
                    streamResult.outcome,
                    totalInserted + streamResult.totalInserted,
                    totalAggregates + streamResult.totalAggregates,
                    totalSamples + streamResult.totalSamples,
                    anyData || streamResult.anyData,
                )
            }
            totalInserted += streamResult.totalInserted
            totalAggregates += streamResult.totalAggregates
            totalSamples += streamResult.totalSamples
            anyData = anyData || streamResult.anyData
            if (!streamResult.anyData) {
                Log.i(TAG, "Phase ${phase.label}: aucune donnée")
            }
        }

        if (
            completeBackfill &&
            ranHistorical &&
            store.getFullBackfillAt() <= 0L &&
            (anyData || totalInserted > 0 || totalAggregates > 0)
        ) {
            store.setFullBackfillComplete(System.currentTimeMillis())
            store.setBackfillPending(false)
            Log.i(TAG, "Backfill 365 j marqué terminé")
        } else if (completeBackfill && ranHistorical && store.getFullBackfillAt() <= 0L) {
            Log.w(TAG, "Backfill historique sans données uploadées — non marqué terminé")
        }

        return PhaseRunAggregate(Outcome.SUCCESS, totalInserted, totalAggregates, totalSamples, anyData)
    }

    private data class HistoricalRun(
        val outcome: Outcome,
        val inserted: Int,
        val aggregates: Int,
        val samples: Int,
    )

    private suspend fun runHistoricalWithCheckpoints(
        store: TokenStore,
        token: String,
        repository: HealthSyncRepository,
        phase: TokenStore.SyncPhase,
    ): HistoricalRun {
        val slices = HistoricalSlicePlanner.buildSlices(phase.startMs, phase.endMs)
        val done = store.loadHistoricalCheckpointDoneIndexes()
        val pending = slices.filter { it.sliceIndex !in done }
        val total = slices.size

        if (total > 0 && pending.isEmpty()) {
            store.clearHistoricalCheckpoint()
            if (store.getLastDataSyncAt() > 0L) {
                Log.i(TAG, "Historique — reprise terminée (données déjà synchronisées)")
            } else {
                Log.w(TAG, "Historique — tranches vides sans upload, checkpoint effacé pour retry")
            }
            return HistoricalRun(Outcome.SUCCESS, 0, 0, 0)
        }

        if (done.isNotEmpty()) {
            Log.i(TAG, "Historique — reprise ${done.size}/$total tranche(s)")
        }

        var inserted = 0
        var aggregates = 0
        var samples = 0

        for (slice in pending) {
            val sliceNum = slice.sliceIndex + 1
            Log.i(TAG, "Historique tranche $sliceNum/$total…")
            val slicePhase = TokenStore.SyncPhase(slice.startMs, slice.endMs, "historical")
            val streamResult = try {
                HealthSyncStreaming.runPhase(
                    repository = repository,
                    store = store,
                    token = token,
                    phase = slicePhase,
                    includeDailyAggregates = slice == pending.last(),
                ) { postResult -> mapPostFailure(store, postResult) }
            } catch (e: Exception) {
                Log.e(TAG, "Collect historical slice $sliceNum échoué: ${e.message}", e)
                return HistoricalRun(Outcome.RETRY, inserted, aggregates, samples)
            }

            if (streamResult.outcome != Outcome.SUCCESS) {
                return HistoricalRun(streamResult.outcome, inserted, aggregates, samples)
            }

            if (!streamResult.anyData) {
                done.add(slice.sliceIndex)
                store.saveHistoricalCheckpoint(done)
                continue
            }

            samples += streamResult.totalSamples
            inserted += streamResult.totalInserted
            aggregates += streamResult.totalAggregates

            done.add(slice.sliceIndex)
            store.saveHistoricalCheckpoint(done)
            Log.i(TAG, "Historique tranche $sliceNum/$total OK")
        }

        store.clearHistoricalCheckpoint()
        Log.i(TAG, "Historique — $total tranche(s) validées")
        return HistoricalRun(Outcome.SUCCESS, inserted, aggregates, samples)
    }

    private suspend fun runDailyExtendedWithCheckpoints(
        store: TokenStore,
        token: String,
        repository: HealthSyncRepository,
        phase: TokenStore.SyncPhase,
    ): HistoricalRun {
        val slices = HistoricalSlicePlanner.buildDailyExtendedSlices(phase.startMs, phase.endMs)
        val done = store.loadDailyExtendedCheckpointDoneIndexes()
        val pending = slices.filter { it.sliceIndex !in done }
        val total = slices.size

        if (total > 0 && pending.isEmpty()) {
            store.clearDailyExtendedCheckpoint()
            return HistoricalRun(Outcome.SUCCESS, 0, 0, 0)
        }

        if (done.isNotEmpty()) {
            Log.i(TAG, "Agrégats 1 an — reprise ${done.size}/$total tranche(s)")
        }

        var inserted = 0
        var aggregates = 0
        var samples = 0

        for (slice in pending) {
            val sliceNum = slice.sliceIndex + 1
            Log.i(TAG, "Agrégats 1 an tranche $sliceNum/$total…")
            val slicePhase = TokenStore.SyncPhase(slice.startMs, slice.endMs, "daily-extended")
            val streamResult = try {
                HealthSyncStreaming.runDailyExtendedPhase(
                    repository = repository,
                    store = store,
                    token = token,
                    phase = slicePhase,
                ) { postResult -> mapPostFailure(store, postResult) }
            } catch (e: Exception) {
                Log.e(TAG, "Agrégats 1 an tranche $sliceNum échouée: ${e.message}", e)
                store.setLastSyncError("daily_extended_slice: ${e.message}")
                return HistoricalRun(Outcome.RETRY, inserted, aggregates, samples)
            }

            if (streamResult.outcome != Outcome.SUCCESS) {
                return HistoricalRun(streamResult.outcome, inserted, aggregates, samples)
            }

            samples += streamResult.totalSamples
            inserted += streamResult.totalInserted
            aggregates += streamResult.totalAggregates

            done.add(slice.sliceIndex)
            store.saveDailyExtendedCheckpoint(done)
            Log.i(TAG, "Agrégats 1 an tranche $sliceNum/$total OK")
        }

        store.clearDailyExtendedCheckpoint()
        Log.i(TAG, "Agrégats 1 an — $total tranche(s) validées")
        return HistoricalRun(Outcome.SUCCESS, inserted, aggregates, samples)
    }

    private fun postPayload(
        store: TokenStore,
        token: String,
        payload: SyncPayload,
        phaseLabel: String,
        includeDailyAggregates: Boolean,
    ): PostResult {
        val fullBody = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = phaseLabel,
            includeDailyAggregates = includeDailyAggregates,
        )
        if (fullBody.toString().length <= MAX_POST_BYTES) {
            return postSync(store, token, fullBody, http)
        }

        var totalInserted = 0
        var totalAggregates = 0
        val types = payload.samplesByType.keys.toList()
        for ((i, type) in types.withIndex()) {
            val partialPayload = payload.copy(
                samplesByType = mapOf(type to (payload.samplesByType[type] ?: emptyList())),
                workouts = if (i == 0) payload.workouts else emptyList(),
                dailyAggregates = if (includeDailyAggregates && i == types.lastIndex) {
                    payload.dailyAggregates
                } else {
                    emptyList()
                },
            )
            val body = HealthSyncPayloadBuilder.build(
                payload = partialPayload,
                syncId = UUID.randomUUID(),
                phaseLabel = "$phaseLabel|$type",
                includeDailyAggregates = includeDailyAggregates && i == types.lastIndex,
            )
            when (val post = postSync(store, token, body, http)) {
                is PostResult.Success -> {
                    totalInserted += post.samplesInserted
                    totalAggregates += post.aggregatesInserted
                }
                else -> return post
            }
        }
        return PostResult.Success(totalInserted, totalAggregates)
    }

    private suspend fun hasBackgroundReadPermission(context: Context): Boolean {
        return try {
            val client = HealthConnectClient.getOrCreate(context)
            val granted = client.permissionController.getGrantedPermissions()
            granted.any { it.contains("READ_HEALTH_DATA_IN_BACKGROUND", ignoreCase = true) }
        } catch (_: Exception) {
            false
        }
    }

    private fun logPayloadSummary(phase: String, payload: SyncPayload) {
        val vo2 = payload.samplesByType["vo2Max"]?.size ?: 0
        val bodyTemp = payload.samplesByType["bodyTemperature"]?.size ?: 0
        val wrist = payload.samplesByType["bodyTemperature"]
            ?.count { it.origin == HealthSyncRepository.ORIGIN_SKIN_TEMPERATURE_WRIST } ?: 0
        Log.i(
            TAG,
            "Phase $phase: ${payload.totalSampleCount()} samples, ${payload.workouts.size} workouts, " +
                "vo2Max=$vo2, bodyTemperature=$bodyTemp (poignet=$wrist)",
        )
    }

    private fun postSync(
        store: TokenStore,
        token: String,
        body: JSONObject,
        client: OkHttpClient,
    ): PostResult {
        val url = "${store.getApiBase().trimEnd('/')}/api/v1/patients/me/health/sync"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                when (response.code) {
                    in 200..299 -> {
                        val json = try {
                            JSONObject(raw)
                        } catch (_: Exception) {
                            JSONObject()
                        }
                        PostResult.Success(
                            samplesInserted = json.optInt("samples_inserted", 0),
                            aggregatesInserted = json.optInt("aggregates_inserted", 0),
                        )
                    }
                    401, 403 -> PostResult.AuthFailure(response.code)
                    in 400..499 -> PostResult.ClientError(response.code, raw.take(300))
                    in 500..599 -> PostResult.ServerError(response.code, raw.take(300))
                    else -> PostResult.ClientError(response.code, raw.take(300))
                }
            }
        } catch (e: Exception) {
            PostResult.NetworkError(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun postRecomputeScores(
        store: TokenStore,
        token: String,
        days: Int,
        client: OkHttpClient,
    ): PostResult {
        val clampedDays = days.coerceIn(1, 365)
        val url = "${store.getApiBase().trimEnd('/')}/api/v1/patients/me/health/recompute?days=$clampedDays"
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .post(ByteArray(0).toRequestBody(JSON_MEDIA))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                when (response.code) {
                    in 200..299 -> PostResult.Success(samplesInserted = 0, aggregatesInserted = 0)
                    401, 403 -> PostResult.AuthFailure(response.code)
                    in 400..499 -> PostResult.ClientError(response.code, raw.take(300))
                    in 500..599 -> PostResult.ServerError(response.code, raw.take(300))
                    else -> PostResult.ClientError(response.code, raw.take(300))
                }
            }
        } catch (e: Exception) {
            PostResult.NetworkError(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun mapPostFailure(store: TokenStore, post: PostResult): Outcome? = when (post) {
        is PostResult.Success -> null
        is PostResult.AuthFailure -> {
            store.clear()
            store.setLastSyncError("auth_${post.code}")
            Outcome.TERMINAL
        }
        is PostResult.ClientError -> {
            store.setLastSyncError("http_${post.code}: ${post.message}")
            Outcome.TERMINAL
        }
        is PostResult.ServerError -> {
            store.setLastSyncError("http_${post.code}: ${post.message}")
            Outcome.RETRY
        }
        is PostResult.NetworkError -> {
            store.setLastSyncError(post.message)
            Outcome.RETRY
        }
    }

    private fun buildSyncSummaryMessage(result: PhaseRunAggregate): String {
        val parts = mutableListOf<String>()
        parts += "${result.totalSamples} samples envoyés"
        parts += "${result.totalInserted} samples insérés"
        if (result.totalAggregates > 0) {
            parts += "${result.totalAggregates} agrégats insérés"
        }
        return parts.joinToString(", ")
    }
}
