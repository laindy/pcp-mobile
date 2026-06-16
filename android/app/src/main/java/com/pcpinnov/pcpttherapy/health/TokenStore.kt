package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * JWT chiffré + métadonnées sync. État backfill scopé par patient via [HealthSyncStateStore].
 */
class TokenStore(private val context: Context) {

    private val app = context.applicationContext
    private val tag = "TokenStore"

    private val masterKey: MasterKey = MasterKey.Builder(app)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val secure: SharedPreferences = EncryptedSharedPreferences.create(
        app,
        PREFS_SECURE,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val meta: SharedPreferences = app.getSharedPreferences(PREFS_META, Context.MODE_PRIVATE)

    private var cachedPatientId: String? = null

    fun setToken(token: String?) {
        val trimmed = token?.trim()?.takeIf { it.isNotBlank() }
        val prevPatient = cachedPatientId ?: resolvePatientId()
        secure.edit().apply {
            if (trimmed == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, trimmed)
            apply()
        }
        val newPatient = JwtPatientId.fromToken(trimmed)
        cachedPatientId = newPatient
        if (prevPatient != null && newPatient != null && prevPatient != newPatient) {
            Log.i(tag, "Compte patient changé — état sync isolé par patient")
        }
        migrateLegacyGlobalStateIfNeeded(newPatient)
    }

    fun getToken(): String? = secure.getString(KEY_TOKEN, null)

    fun resolvePatientId(): String? {
        cachedPatientId?.let { return it }
        val pid = JwtPatientId.fromToken(getToken())
        cachedPatientId = pid
        return pid
    }

    fun clear() {
        secure.edit().clear().apply()
        meta.edit().clear().apply()
        cachedPatientId = null
    }

    fun setApiBase(url: String?) {
        secure.edit().apply {
            if (url.isNullOrBlank()) remove(KEY_API_BASE) else putString(KEY_API_BASE, url.trimEnd('/'))
            apply()
        }
    }

    fun getApiBase(): String = secure.getString(KEY_API_BASE, null) ?: DEFAULT_API_BASE

    fun setLastSync(
        epochMillis: Long,
        samplesInserted: Int,
        aggregatesInserted: Int,
        message: String?,
    ) {
        val pid = resolvePatientId()
        meta.edit()
            .putLong(KEY_LAST_SYNC_AT, epochMillis)
            .putLong(KEY_LAST_ATTEMPT_AT, epochMillis)
            .putString(KEY_LAST_OUTCOME, OUTCOME_OK)
            .putInt(KEY_LAST_SYNC_INSERTED, samplesInserted)
            .putInt(KEY_LAST_AGGREGATES_INSERTED, aggregatesInserted)
            .putString(KEY_LAST_SYNC_MESSAGE, message)
            .apply()
        if (pid != null) {
            HealthSyncStateStore.setField(
                app,
                pid,
                HealthSyncStateStore.KEY_LAST_DATA_SYNC_AT,
                epochMillis.toString(),
            )
        }
        meta.edit().putLong(KEY_LAST_DATA_SYNC_AT, epochMillis).apply()
    }

    fun setLastSyncEmpty(epochMillis: Long, message: String?) {
        meta.edit()
            .putLong(KEY_LAST_ATTEMPT_AT, epochMillis)
            .putString(KEY_LAST_OUTCOME, OUTCOME_EMPTY)
            .putString(KEY_LAST_SYNC_MESSAGE, message)
            .apply()
    }

    fun setLastSyncError(message: String?) {
        val now = System.currentTimeMillis()
        meta.edit()
            .putString(KEY_LAST_SYNC_MESSAGE, message)
            .putLong(KEY_LAST_SYNC_ERROR_AT, now)
            .putLong(KEY_LAST_ATTEMPT_AT, now)
            .putString(KEY_LAST_OUTCOME, OUTCOME_ERROR)
            .apply()
    }

    fun setSyncAttemptStarted(epochMillis: Long) {
        meta.edit()
            .putLong(KEY_LAST_ATTEMPT_AT, epochMillis)
            .putString(KEY_LAST_OUTCOME, OUTCOME_RUNNING)
            .apply()
    }

    fun getLastSyncAt(): Long = meta.getLong(KEY_LAST_SYNC_AT, 0L)

    fun getLastDataSyncAt(): Long {
        val pid = resolvePatientId()
        val scoped = if (pid != null) {
            HealthSyncStateStore.getLong(app, pid, HealthSyncStateStore.KEY_LAST_DATA_SYNC_AT)
        } else {
            0L
        }
        return maxOf(scoped, meta.getLong(KEY_LAST_DATA_SYNC_AT, 0L))
    }

    fun getFullBackfillAt(): Long = getFullBackfillAt(resolvePatientId())

    fun getFullBackfillAt(patientId: String?): Long {
        if (patientId.isNullOrBlank()) return meta.getLong(KEY_FULL_BACKFILL_AT, 0L)
        val scoped = HealthSyncStateStore.getLong(app, patientId, HealthSyncStateStore.KEY_FULL_BACKFILL_AT)
        return maxOf(scoped, meta.getLong(KEY_FULL_BACKFILL_AT, 0L))
    }

    fun setFullBackfillComplete(epochMillis: Long = System.currentTimeMillis()) {
        val pid = resolvePatientId()
        meta.edit().putLong(KEY_FULL_BACKFILL_AT, epochMillis).apply()
        if (pid != null) {
            HealthSyncStateStore.setField(
                app,
                pid,
                HealthSyncStateStore.KEY_FULL_BACKFILL_AT,
                epochMillis.toString(),
            )
            setBackfillPending(pid, false)
        }
    }

    fun isBackfillPending(): Boolean = isBackfillPending(resolvePatientId())

    fun isBackfillPending(patientId: String?): Boolean {
        if (patientId.isNullOrBlank()) return false
        return HealthSyncStateStore.getBooleanFlag(
            app,
            patientId,
            HealthSyncStateStore.KEY_BACKFILL_PENDING,
        )
    }

    fun setBackfillPending(pending: Boolean) {
        val pid = resolvePatientId() ?: return
        setBackfillPending(pid, pending)
    }

    fun setBackfillPending(patientId: String, pending: Boolean) {
        HealthSyncStateStore.setField(
            app,
            patientId,
            HealthSyncStateStore.KEY_BACKFILL_PENDING,
            if (pending) "1" else null,
        )
    }

    fun getStepsRepairAt(patientId: String): Long =
        HealthSyncStateStore.getLong(app, patientId, HealthSyncStateStore.KEY_STEPS_REPAIR)

    fun setStepsRepairAt(patientId: String, epochMillis: Long) {
        HealthSyncStateStore.setField(
            app,
            patientId,
            HealthSyncStateStore.KEY_STEPS_REPAIR,
            epochMillis.toString(),
        )
    }

    fun getVitalsResyncAt(patientId: String?): Long =
        HealthSyncStateStore.getLong(app, patientId, HealthSyncStateStore.KEY_VITALS_DAILY_REPAIR)

    fun setVitalsResyncAt(patientId: String, epochMillis: Long) {
        HealthSyncStateStore.setField(
            app,
            patientId,
            HealthSyncStateStore.KEY_VITALS_DAILY_REPAIR,
            epochMillis.toString(),
        )
    }

    fun getSleepDailyRepairAt(patientId: String): Long =
        HealthSyncStateStore.getLong(app, patientId, HealthSyncStateStore.KEY_SLEEP_DAILY_REPAIR)

    fun setSleepDailyRepairAt(patientId: String, epochMillis: Long) {
        HealthSyncStateStore.setField(
            app,
            patientId,
            HealthSyncStateStore.KEY_SLEEP_DAILY_REPAIR,
            epochMillis.toString(),
        )
    }

    fun getSleepStagesRepairAt(patientId: String): Long =
        HealthSyncStateStore.getLong(app, patientId, HealthSyncStateStore.KEY_SLEEP_STAGES_REPAIR)

    fun setSleepStagesRepairAt(patientId: String, epochMillis: Long) {
        HealthSyncStateStore.setField(
            app,
            patientId,
            HealthSyncStateStore.KEY_SLEEP_STAGES_REPAIR,
            epochMillis.toString(),
        )
    }

    fun getRecoveryRescoreRepairAt(patientId: String): Long =
        HealthSyncStateStore.getLong(app, patientId, HealthSyncStateStore.KEY_RECOVERY_RESCORE_REPAIR)

    fun setRecoveryRescoreRepairAt(patientId: String, epochMillis: Long) {
        HealthSyncStateStore.setField(
            app,
            patientId,
            HealthSyncStateStore.KEY_RECOVERY_RESCORE_REPAIR,
            epochMillis.toString(),
        )
    }

    fun loadHistoricalCheckpointDoneIndexes(): MutableSet<Int> {
        val pid = resolvePatientId() ?: return mutableSetOf()
        val raw = HealthSyncStateStore.getState(app, pid)[HealthSyncStateStore.KEY_HISTORICAL_CHECKPOINT]
            ?: return mutableSetOf()
        return try {
            val json = JSONObject(raw)
            val arr = json.optJSONArray("doneIndexes") ?: JSONArray()
            buildSet {
                for (i in 0 until arr.length()) {
                    add(arr.optInt(i))
                }
            }.toMutableSet()
        } catch (_: Exception) {
            mutableSetOf()
        }
    }

    fun saveHistoricalCheckpoint(doneIndexes: Set<Int>) {
        val pid = resolvePatientId() ?: return
        val json = JSONObject()
            .put("doneIndexes", JSONArray(doneIndexes.sorted()))
            .put("updatedAt", System.currentTimeMillis())
        HealthSyncStateStore.setField(
            app,
            pid,
            HealthSyncStateStore.KEY_HISTORICAL_CHECKPOINT,
            json.toString(),
        )
    }

    fun clearHistoricalCheckpoint() {
        val pid = resolvePatientId() ?: return
        HealthSyncStateStore.setField(app, pid, HealthSyncStateStore.KEY_HISTORICAL_CHECKPOINT, null)
    }

    fun loadDailyExtendedCheckpointDoneIndexes(): MutableSet<Int> {
        val pid = resolvePatientId() ?: return mutableSetOf()
        val raw = HealthSyncStateStore.getState(app, pid)[HealthSyncStateStore.KEY_DAILY_EXTENDED_CHECKPOINT]
            ?: return mutableSetOf()
        return try {
            val json = JSONObject(raw)
            val arr = json.optJSONArray("doneIndexes") ?: JSONArray()
            buildSet {
                for (i in 0 until arr.length()) {
                    add(arr.optInt(i))
                }
            }.toMutableSet()
        } catch (_: Exception) {
            mutableSetOf()
        }
    }

    fun saveDailyExtendedCheckpoint(doneIndexes: Set<Int>) {
        val pid = resolvePatientId() ?: return
        val json = JSONObject()
            .put("doneIndexes", JSONArray(doneIndexes.sorted()))
            .put("updatedAt", System.currentTimeMillis())
        HealthSyncStateStore.setField(
            app,
            pid,
            HealthSyncStateStore.KEY_DAILY_EXTENDED_CHECKPOINT,
            json.toString(),
        )
    }

    fun clearDailyExtendedCheckpoint() {
        val pid = resolvePatientId() ?: return
        HealthSyncStateStore.setField(app, pid, HealthSyncStateStore.KEY_DAILY_EXTENDED_CHECKPOINT, null)
    }

    fun reconcileBackfillState() {
        val pid = resolvePatientId() ?: return
        val fullAt = getFullBackfillAt(pid)
        val lastData = getLastDataSyncAt()

        if (fullAt > 0L && lastData <= 0L) {
            meta.edit().remove(KEY_FULL_BACKFILL_AT).apply()
            HealthSyncStateStore.setField(
                app,
                pid,
                HealthSyncStateStore.KEY_FULL_BACKFILL_AT,
                null,
            )
            clearHistoricalCheckpoint()
            Log.w(tag, "Backfill marqué terminé sans données — réinitialisation")
        }

        if (getFullBackfillAt(pid) > 0L && isBackfillPending(pid)) {
            setBackfillPending(pid, false)
            Log.i(tag, "État sync réconcilié — backfill terminé, pending obsolète effacé")
        }
    }

    /**
     * Aligné iOS [resolveSyncPlan] :
     * - backfill incomplet → phase récente puis historique 60 j ;
     * - backfill pending interrompu → reprise historical seul ;
     * - backfill OK → fenêtre incrémentale 48 h (+ overlap 24 h).
     */
    fun resolveSyncPhases(nowMs: Long = System.currentTimeMillis(), forceFullLookback: Boolean = false): List<SyncPhase> {
        val pid = resolvePatientId()
        var fullBackfillAt = getFullBackfillAt(pid)
        val lastDataSync = getLastDataSyncAt()

        // Ne pas marquer le backfill intraday (90 j) terminé tant qu'aucune phase historical n'a couru
        // (évite de masquer le bandeau au 1er compte / 1ère sync sur l'appareil).

        if (fullBackfillAt > 0L && !forceFullLookback) {
            val minStart = nowMs - INCREMENTAL_LOOKBACK_MS
            val overlapStart = if (lastDataSync > 0L) lastDataSync - INCREMENTAL_OVERLAP_MS else minStart
            val start = minOf(minStart, overlapStart)
            return listOf(SyncPhase(start, nowMs, "incremental"))
        }

        if (isBackfillPending(pid) && !HealthSyncExecutor.isBackfillRunning()) {
            val dailyStart = nowMs - DAILY_AGGREGATE_LOOKBACK_MS
            val sampleStart = nowMs - SAMPLE_INTRADAY_LOOKBACK_MS
            val recentStart = nowMs - PRIORITY_LOOKBACK_MS
            val phases = mutableListOf<SyncPhase>()
            if (sampleStart < recentStart) {
                phases += SyncPhase(sampleStart, recentStart, "historical")
            }
            if (dailyStart < sampleStart) {
                phases += SyncPhase(dailyStart, sampleStart, "daily-extended")
            }
            if (phases.isNotEmpty()) {
                Log.i(tag, "Backfill historique interrompu — reprise par tranches")
                return phases
            }
        }

        val dailyStart = nowMs - DAILY_AGGREGATE_LOOKBACK_MS
        val sampleStart = nowMs - SAMPLE_INTRADAY_LOOKBACK_MS
        val recentMs = if (lastDataSync > 0L) INCREMENTAL_LOOKBACK_MS else PRIORITY_LOOKBACK_MS
        val recentStart = nowMs - recentMs
        val phases = mutableListOf(
            SyncPhase(recentStart, nowMs, if (lastDataSync > 0L) "catch-up" else "priority"),
        )
        if (sampleStart < recentStart) {
            phases += SyncPhase(sampleStart, recentStart, "historical")
        }
        if (dailyStart < sampleStart) {
            phases += SyncPhase(dailyStart, sampleStart, "daily-extended")
        }
        return phases
    }

    fun clearStaleErrorIfOlderThan(maxAgeMillis: Long) {
        if (getLastOutcome() != OUTCOME_ERROR) return
        val attempt = getLastAttemptAt()
        if (attempt <= 0L) return
        if (System.currentTimeMillis() - attempt >= maxAgeMillis) {
            meta.edit()
                .remove(KEY_LAST_OUTCOME)
                .remove(KEY_LAST_SYNC_MESSAGE)
                .apply()
        }
    }

    fun getLastAttemptAt(): Long = meta.getLong(KEY_LAST_ATTEMPT_AT, 0L)
    fun getLastOutcome(): String = meta.getString(KEY_LAST_OUTCOME, "") ?: ""
    fun getLastSyncErrorAt(): Long = meta.getLong(KEY_LAST_SYNC_ERROR_AT, 0L)
    fun getLastSyncMessage(): String? = meta.getString(KEY_LAST_SYNC_MESSAGE, null)
    fun getLastSyncInserted(): Int = meta.getInt(KEY_LAST_SYNC_INSERTED, 0)
    fun getLastAggregatesInserted(): Int = meta.getInt(KEY_LAST_AGGREGATES_INSERTED, 0)

    private fun migrateLegacyGlobalStateIfNeeded(patientId: String?) {
        if (patientId.isNullOrBlank()) return
        val legacyFull = meta.getLong(KEY_FULL_BACKFILL_AT, 0L)
        if (legacyFull > 0L && getFullBackfillAt(patientId) <= 0L) {
            HealthSyncStateStore.setField(
                app,
                patientId,
                HealthSyncStateStore.KEY_FULL_BACKFILL_AT,
                legacyFull.toString(),
            )
        }
        val legacyData = meta.getLong(KEY_LAST_DATA_SYNC_AT, 0L)
        if (legacyData > 0L) {
            val scoped = HealthSyncStateStore.getLong(
                app,
                patientId,
                HealthSyncStateStore.KEY_LAST_DATA_SYNC_AT,
            )
            if (scoped <= 0L) {
                HealthSyncStateStore.setField(
                    app,
                    patientId,
                    HealthSyncStateStore.KEY_LAST_DATA_SYNC_AT,
                    legacyData.toString(),
                )
            }
        }
    }

    data class SyncPhase(val startMs: Long, val endMs: Long, val label: String)

    companion object {
        private const val PREFS_SECURE = "pcp_health_secure_prefs"
        private const val PREFS_META = "pcp_health_meta_prefs"

        private const val KEY_TOKEN = "patient_jwt"
        private const val KEY_API_BASE = "api_base"
        private const val KEY_LAST_SYNC_AT = "last_sync_at_ms"
        private const val KEY_LAST_SYNC_ERROR_AT = "last_sync_error_at_ms"
        private const val KEY_LAST_SYNC_MESSAGE = "last_sync_message"
        private const val KEY_LAST_SYNC_INSERTED = "last_sync_inserted"
        private const val KEY_LAST_AGGREGATES_INSERTED = "last_aggregates_inserted"
        private const val KEY_LAST_DATA_SYNC_AT = "last_data_sync_at_ms"
        private const val KEY_FULL_BACKFILL_AT = "full_backfill_at_ms"
        private const val KEY_LAST_ATTEMPT_AT = "last_attempt_at_ms"
        private const val KEY_LAST_OUTCOME = "last_sync_outcome"

        const val OUTCOME_OK = "ok"
        const val OUTCOME_EMPTY = "empty"
        const val OUTCOME_ERROR = "error"
        const val OUTCOME_RUNNING = "running"

        const val DEFAULT_API_BASE = "https://patient.pcpinnov.com"

        const val DAILY_AGGREGATE_LOOKBACK_MS: Long = 365L * 24 * 60 * 60 * 1000
        const val SAMPLE_INTRADAY_LOOKBACK_MS: Long = 90L * 24 * 60 * 60 * 1000
        /** Alias probe / agrégats journaliers. */
        const val FULL_LOOKBACK_MS: Long = DAILY_AGGREGATE_LOOKBACK_MS
        const val PRIORITY_LOOKBACK_MS: Long = 7L * 24 * 60 * 60 * 1000
        const val INCREMENTAL_LOOKBACK_MS: Long = 48L * 60 * 60 * 1000
        const val INCREMENTAL_OVERLAP_MS: Long = 24L * 60 * 60 * 1000

        const val DEFAULT_LOOKBACK_MS: Long = DAILY_AGGREGATE_LOOKBACK_MS
    }
}
