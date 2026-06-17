package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * État sync santé par patient — survit au reload WebView (aligné iOS [HealthSyncStateStore]).
 */
object HealthSyncStateStore {

    const val KEY_FULL_BACKFILL_AT = "pcpHealthFullBackfillAt"
    const val KEY_BACKFILL_PENDING = "pcpHealthBackfillPending"
    const val KEY_HISTORICAL_CHECKPOINT = "pcpHealthHistoricalCheckpoint"
    const val KEY_LAST_DATA_SYNC_AT = "pcpHealthLastDataSyncAt"
    const val KEY_STEPS_REPAIR = "pcpHealthStepsRepairV2"
    const val KEY_AGGREGATES_BACKFILL = "pcpHealthAggregatesV8"
    const val KEY_VITALS_DAILY_REPAIR = "pcpHealthVitalsDailyRepairV1"
    const val KEY_SLEEP_DAILY_REPAIR = "pcpHealthSleepDailyRepairV2"
    const val KEY_SLEEP_STAGES_REPAIR = "pcpHealthSleepStagesRepairV1"
    const val KEY_DAILY_EXTENDED_CHECKPOINT = "pcpHealthDailyExtendedCheckpoint"
    const val KEY_RECOVERY_RESCORE_REPAIR = "pcpHealthRecoveryRescoreRepairV3"

    private const val PREFS = "pcp_health_sync_state_by_patient"
    private const val KEY_PREFIX = "pcp_health_sync_state_"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun storageKey(patientId: String): String = KEY_PREFIX + patientId

    fun getState(context: Context, patientId: String): Map<String, String> {
        if (patientId.isBlank()) return emptyMap()
        val raw = prefs(context).getString(storageKey(patientId), null) ?: return emptyMap()
        return try {
            val json = JSONObject(raw)
            buildMap {
                val keys = json.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val v = json.optString(k, "")
                    if (v.isNotBlank()) put(k, v)
                }
            }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    fun getStateJson(context: Context, patientId: String): String {
        val map = getState(context, patientId)
        return JSONObject(map as Map<*, *>).toString()
    }

    fun setField(context: Context, patientId: String, key: String, value: String?) {
        if (patientId.isBlank() || key.isBlank()) return
        val store = prefs(context)
        val sk = storageKey(patientId)
        val current = JSONObject(getState(context, patientId) as Map<*, *>)
        if (value.isNullOrBlank()) {
            current.remove(key)
        } else {
            current.put(key, value)
        }
        if (current.length() == 0) {
            store.edit().remove(sk).apply()
        } else {
            store.edit().putString(sk, current.toString()).apply()
        }
    }

    fun clearPatient(context: Context, patientId: String) {
        if (patientId.isBlank()) return
        prefs(context).edit().remove(storageKey(patientId)).apply()
    }

    fun getLong(context: Context, patientId: String?, key: String): Long {
        if (patientId.isNullOrBlank()) return 0L
        return getState(context, patientId)[key]?.toLongOrNull() ?: 0L
    }

    fun getBooleanFlag(context: Context, patientId: String?, key: String): Boolean {
        if (patientId.isNullOrBlank()) return false
        return getState(context, patientId)[key] == "1"
    }
}
