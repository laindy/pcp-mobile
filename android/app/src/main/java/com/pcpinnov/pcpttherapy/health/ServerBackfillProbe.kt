package com.pcpinnov.pcpttherapy.health

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

/**
 * Aligné sur [health-server-backfill-probe.js] — skip backfill 60 j + détection gaps steps.
 */
object ServerBackfillProbe {

    private const val TAG = "ServerBackfillProbe"
    private const val FULL_LOOKBACK_DAYS = 365L
    private const val MIN_DAYS_WITH_SIGNAL = 210
    private const val MIN_SPARSE_DAYS_WITH_SIGNAL = 14
    private const val MIN_SPAN_DAYS = 330
    private const val MIN_HISTORICAL_STAGED_NIGHTS = 20
    private const val MIN_HISTORICAL_SLEEP_NIGHTS_TO_REQUIRE = 10
    private const val PRIORITY_LOOKBACK_DAYS = 7L
    private const val OLDEST_SLACK_DAYS = 14L
    private val SYNTHETIC_SLEEP_PLATFORM_RE = Regex("^sleep\\|agg\\|", RegexOption.IGNORE_CASE)
    private val DAY_FMT: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    data class Result(
        val applied: Boolean,
        val reason: String,
        val daysWithData: Int = 0,
        val rowCount: Int = 0,
        val oldestDay: String? = null,
        val spanDays: Int = 0,
        val batchTotal: Int? = null,
        val sparseProfile: Boolean = false,
    )

    data class StepsGaps(
        val missingCount: Int,
        val missingDays: List<String>,
        val rowCount: Int,
    )

    data class SleepStagesGaps(
        val needsRepair: Boolean,
        val historicalSleepNights: Int,
        val stagedNights: Int,
    )

    @JvmStatic
    fun probeSleepStagesGaps(store: TokenStore, http: OkHttpClient): SleepStagesGaps {
        val probe = probeServerHistoricalCoverage(store, http)
        val dayFrom = LocalDate.now().minusDays(FULL_LOOKBACK_DAYS)
        val sleepProbe = probeSleepStagesCoverage(store, http, probe.rows, dayFrom)
        return SleepStagesGaps(
            needsRepair = sleepProbe.needsRepair,
            historicalSleepNights = sleepProbe.historicalSleepNights,
            stagedNights = sleepProbe.stagedNights,
        )
    }

    @JvmStatic
    fun tryMarkComplete(store: TokenStore, http: OkHttpClient): Result {
        val patientId = store.resolvePatientId()
        if (store.getFullBackfillAt(patientId) > 0L) {
            return Result(applied = false, reason = "already_local")
        }
        val token = store.getToken()
        if (token.isNullOrBlank()) {
            return Result(applied = false, reason = "no_token")
        }

        // Ne pas court-circuiter le backfill HC tant que cet appareil n'a pas réussi
        // au moins une sync locale (réinstall / 1ère ouverture — le serveur peut déjà
        // avoir des données d'un autre appareil ou d'une session précédente).
        if (store.getLastDataSyncAt() <= 0L) {
            Log.i(TAG, "Skip probe différé — aucune sync locale réussie sur cet appareil")
            return Result(applied = false, reason = "no_local_sync_yet")
        }

        val probe = probeServerHistoricalCoverage(store, http)
        if (!probe.sufficient) {
            Log.i(
                TAG,
                "Couverture insuffisante: ${probe.daysWithData}/$FULL_LOOKBACK_DAYS j, oldest=${probe.oldestDay}",
            )
            return Result(
                applied = false,
                reason = probe.reason,
                daysWithData = probe.daysWithData,
                rowCount = probe.rowCount,
                oldestDay = probe.oldestDay,
                spanDays = probe.spanDays,
                batchTotal = probe.batchTotal,
                sparseProfile = probe.sparseProfile,
            )
        }

        val dayFrom = LocalDate.now().minusDays(FULL_LOOKBACK_DAYS)
        val sleepProbe = probeSleepStagesCoverage(store, http, probe.rows, dayFrom)
        if (sleepProbe.needsRepair) {
            Log.i(
                TAG,
                "Stades sommeil historiques insuffisants: ${sleepProbe.stagedNights}/${sleepProbe.historicalSleepNights} nuits — pas de skip backfill",
            )
            return Result(
                applied = false,
                reason = "sleep_stages_insufficient",
                daysWithData = probe.daysWithData,
                rowCount = probe.rowCount,
                oldestDay = probe.oldestDay,
                spanDays = probe.spanDays,
                batchTotal = probe.batchTotal,
                sparseProfile = probe.sparseProfile,
            )
        }

        store.setFullBackfillComplete(System.currentTimeMillis())
        store.reconcileBackfillState()
        val sparseNote = if (probe.sparseProfile) " profil-épars" else ""
        Log.i(
            TAG,
            "Skip backfill 60j — serveur OK (${probe.daysWithData}j signal, span=${probe.spanDays}$sparseNote)",
        )
        return Result(
            applied = true,
            reason = if (probe.sparseProfile) "ok_sparse" else "ok",
            daysWithData = probe.daysWithData,
            rowCount = probe.rowCount,
            oldestDay = probe.oldestDay,
            spanDays = probe.spanDays,
            batchTotal = probe.batchTotal,
            sparseProfile = probe.sparseProfile,
        )
    }

    fun probeStepsGaps(store: TokenStore, http: OkHttpClient): StepsGaps {
        val probe = probeServerHistoricalCoverage(store, http)
        return evaluateStepsGaps(probe.rows)
    }

    private data class CoverageProbe(
        val sufficient: Boolean,
        val reason: String,
        val daysWithData: Int,
        val rowCount: Int,
        val oldestDay: String?,
        val spanDays: Int,
        val batchTotal: Int?,
        val sparseProfile: Boolean,
        val rows: JSONArray,
    )

    private fun probeServerHistoricalCoverage(store: TokenStore, http: OkHttpClient): CoverageProbe {
        val token = store.getToken()
        if (token.isNullOrBlank()) {
            return CoverageProbe(
                sufficient = false,
                reason = "no_token",
                daysWithData = 0,
                rowCount = 0,
                oldestDay = null,
                spanDays = 0,
                batchTotal = null,
                sparseProfile = false,
                rows = JSONArray(),
            )
        }

        val dayFrom = LocalDate.now().minusDays(FULL_LOOKBACK_DAYS)
        val dayFromStr = dayFrom.format(DAY_FMT)
        val base = store.getApiBase().trimEnd('/')
        val dailyUrl =
            "$base/api/v1/patients/me/health/daily?day_from=$dayFromStr&limit=$FULL_LOOKBACK_DAYS"

        val client = http.newBuilder()
            .callTimeout(12, TimeUnit.SECONDS)
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build()

        return try {
            val request = Request.Builder()
                .url(dailyUrl)
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return CoverageProbe(
                        sufficient = false,
                        reason = "http_${response.code}",
                        daysWithData = 0,
                        rowCount = 0,
                        oldestDay = null,
                        spanDays = 0,
                        batchTotal = null,
                        sparseProfile = false,
                        rows = JSONArray(),
                    )
                }
                val body = response.body?.string().orEmpty()
                val rows = JSONArray(body)
                val batchTotal = fetchBatchTotal(client, base, token)
                val coverage = evaluateCoverage(rows, dayFrom, batchTotal)
                CoverageProbe(
                    sufficient = coverage.sufficient,
                    reason = coverage.reason,
                    daysWithData = coverage.daysWithData,
                    rowCount = rows.length(),
                    oldestDay = coverage.oldestDay,
                    spanDays = coverage.spanDays,
                    batchTotal = batchTotal,
                    sparseProfile = coverage.sparseProfile,
                    rows = rows,
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Probe échoué: ${e.message}")
            CoverageProbe(
                sufficient = false,
                reason = e.message ?: "error",
                daysWithData = 0,
                rowCount = 0,
                oldestDay = null,
                spanDays = 0,
                batchTotal = null,
                sparseProfile = false,
                rows = JSONArray(),
            )
        }
    }

    private fun fetchBatchTotal(client: OkHttpClient, base: String, token: String): Int? {
        return try {
            val request = Request.Builder()
                .url("$base/api/v1/patients/me/health/sync-batches?page_size=1")
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .get()
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = JSONObject(response.body?.string().orEmpty())
                if (body.has("total")) body.optInt("total") else null
            }
        } catch (_: Exception) {
            null
        }
    }

    private data class Coverage(
        val sufficient: Boolean,
        val reason: String,
        val daysWithData: Int,
        val oldestDay: String?,
        val spanDays: Int,
        val sparseProfile: Boolean,
    )

    private fun evaluateCoverage(
        rows: JSONArray,
        dayFrom: LocalDate,
        batchTotal: Int?,
    ): Coverage {
        if (rows.length() == 0) {
            return Coverage(
                sufficient = false,
                reason = "empty",
                daysWithData = 0,
                oldestDay = null,
                spanDays = 0,
                sparseProfile = false,
            )
        }

        var daysWithData = 0
        var oldest: LocalDate? = null
        var newest: LocalDate? = null

        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val dayStr = row.optString("day", "")
            if (dayStr.isBlank()) continue
            val day = try {
                LocalDate.parse(dayStr, DAY_FMT)
            } catch (_: Exception) {
                continue
            }
            if (rowHasSignal(row)) daysWithData += 1
            if (oldest == null || day.isBefore(oldest)) oldest = day
            if (newest == null || day.isAfter(newest)) newest = day
        }

        val spanDays = if (oldest != null && newest != null) {
            ChronoUnit.DAYS.between(oldest, newest).toInt() + 1
        } else {
            rows.length()
        }

        val oldestThreshold = dayFrom.plusDays(OLDEST_SLACK_DAYS)
        val oldestOk = oldest != null && !oldest.isAfter(oldestThreshold)
        val denseSufficient =
            daysWithData >= MIN_DAYS_WITH_SIGNAL && (oldestOk || spanDays >= MIN_SPAN_DAYS)
        val batchesOk = batchTotal != null && batchTotal > 0
        val sparseSufficient =
            batchesOk &&
                oldestOk &&
                spanDays >= MIN_SPAN_DAYS &&
                daysWithData >= MIN_SPARSE_DAYS_WITH_SIGNAL
        val sufficient = denseSufficient || sparseSufficient

        return Coverage(
            sufficient = sufficient,
            reason = when {
                !sufficient -> "insufficient_coverage"
                sparseSufficient && !denseSufficient -> "ok_sparse"
                else -> "ok"
            },
            daysWithData = daysWithData,
            oldestDay = oldest?.format(DAY_FMT),
            spanDays = spanDays,
            sparseProfile = sparseSufficient && !denseSufficient,
        )
    }

    private fun evaluateStepsGaps(rows: JSONArray): StepsGaps {
        val missing = mutableListOf<String>()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            if (dayRowMissingSteps(row)) {
                missing += row.optString("day", "")
            }
        }
        return StepsGaps(
            missingCount = missing.size,
            missingDays = missing.sorted(),
            rowCount = rows.length(),
        )
    }

    private fun rowHasSignal(row: JSONObject): Boolean {
        if (row.optInt("steps_total", 0) > 0) return true
        if (row.optInt("sleep_total_min", 0) > 0) return true
        if (row.optDouble("hrv_avg_ms", 0.0) > 0.0) return true
        if (row.optDouble("calories_total_kcal", 0.0) > 0.0) return true
        if (row.optDouble("resting_heart_rate_avg", 0.0) > 0.0) return true
        return false
    }

    private fun dayRowMissingSteps(row: JSONObject): Boolean {
        if (!row.has("day")) return false
        if (row.optInt("steps_total", 0) > 0) return false
        if (row.optInt("sleep_total_min", 0) > 0) return true
        if (row.optDouble("calories_total_kcal", 0.0) > 0.0) return true
        if (row.optDouble("hrv_avg_ms", 0.0) > 0.0) return true
        if (row.optDouble("resting_heart_rate_avg", 0.0) > 0.0) return true
        if (row.optDouble("respiratory_rate_avg", 0.0) > 0.0) return true
        if (row.optDouble("oxygen_saturation_avg", 0.0) > 0.0) return true
        return false
    }

    private data class SleepStagesProbe(
        val needsRepair: Boolean,
        val historicalSleepNights: Int,
        val stagedNights: Int,
    )

    private fun historicalCutoffDay(): LocalDate = LocalDate.now().minusDays(PRIORITY_LOOKBACK_DAYS)

    private fun isHistoricalDay(day: LocalDate, dayFrom: LocalDate, cutoff: LocalDate): Boolean =
        !day.isBefore(dayFrom) && day.isBefore(cutoff)

    private fun isSyntheticSleepSample(item: JSONObject): Boolean {
        val pid = item.optString("platform_id", "")
        if (SYNTHETIC_SLEEP_PLATFORM_RE.containsMatchIn(pid)) return true
        val stage = item.optJSONObject("extra")?.optString("stage", "") ?: ""
        return stage.isBlank() || stage == "night"
    }

    private fun isRealStagedSleepSample(item: JSONObject): Boolean {
        if (item.optString("data_type", "") != "sleep") return false
        if (isSyntheticSleepSample(item)) return false
        val stage = item.optJSONObject("extra")?.optString("stage", "")?.trim().orEmpty()
        return stage.isNotEmpty()
    }

    private fun wakeDayFromSample(item: JSONObject): LocalDate? {
        val end = item.optString("end_at", "")
        if (end.isBlank()) return null
        return try {
            LocalDate.parse(end.substring(0, 10), DAY_FMT)
        } catch (_: Exception) {
            null
        }
    }

    private fun countHistoricalSleepNights(rows: JSONArray, dayFrom: LocalDate, cutoff: LocalDate): Int {
        var count = 0
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val dayStr = row.optString("day", "")
            if (dayStr.isBlank()) continue
            val day = try {
                LocalDate.parse(dayStr, DAY_FMT)
            } catch (_: Exception) {
                continue
            }
            if (!isHistoricalDay(day, dayFrom, cutoff)) continue
            if (row.optInt("sleep_total_min", 0) > 0) count += 1
        }
        return count
    }

    private fun fetchSleepSamples(
        client: OkHttpClient,
        base: String,
        token: String,
        dayFrom: LocalDate,
        maxPages: Int = 4,
    ): JSONArray {
        val merged = JSONArray()
        val dateFrom = "${dayFrom.format(DAY_FMT)}T00:00:00.000Z"
        for (page in 1..maxPages) {
            val url =
                "$base/api/v1/patients/me/health/samples?data_type=sleep&date_from=$dateFrom&page=$page&page_size=500&sort_order=desc"
            val request = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .get()
                .build()
            val pageItems = client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return merged
                val body = JSONObject(response.body?.string().orEmpty())
                body.optJSONArray("items") ?: JSONArray()
            }
            for (i in 0 until pageItems.length()) {
                merged.put(pageItems.optJSONObject(i))
            }
            if (pageItems.length() < 500) break
        }
        return merged
    }

    private fun probeSleepStagesCoverage(
        store: TokenStore,
        http: OkHttpClient,
        rows: JSONArray,
        dayFrom: LocalDate,
    ): SleepStagesProbe {
        val token = store.getToken()
        if (token.isNullOrBlank()) {
            return SleepStagesProbe(needsRepair = false, historicalSleepNights = 0, stagedNights = 0)
        }
        val cutoff = historicalCutoffDay()
        val historicalSleepNights = countHistoricalSleepNights(rows, dayFrom, cutoff)
        val client = http.newBuilder()
            .callTimeout(12, TimeUnit.SECONDS)
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build()
        val samples = try {
            fetchSleepSamples(client, store.getApiBase().trimEnd('/'), token, dayFrom)
        } catch (e: Exception) {
            Log.w(TAG, "Probe sommeil stades: ${e.message}")
            return SleepStagesProbe(needsRepair = false, historicalSleepNights = historicalSleepNights, stagedNights = 0)
        }

        val staged = mutableSetOf<String>()
        for (i in 0 until samples.length()) {
            val item = samples.optJSONObject(i) ?: continue
            val wake = wakeDayFromSample(item) ?: continue
            if (!isHistoricalDay(wake, dayFrom, cutoff)) continue
            if (isRealStagedSleepSample(item)) {
                staged += wake.format(DAY_FMT)
            }
        }
        val stagedCount = staged.size
        val needsRepair =
            historicalSleepNights >= MIN_HISTORICAL_SLEEP_NIGHTS_TO_REQUIRE &&
                stagedCount < MIN_HISTORICAL_STAGED_NIGHTS &&
                stagedCount < kotlin.math.ceil(historicalSleepNights * 0.7).toInt()
        return SleepStagesProbe(
            needsRepair = needsRepair,
            historicalSleepNights = historicalSleepNights,
            stagedNights = stagedCount,
        )
    }
}
