package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.UUID

/**
 * Réparation 1× énergie/effort récents — aligné iOS [maybeRepairHistoricalActivityCalories].
 */
object ActivityCaloriesRepairExecutor {

    private const val TAG = "ActivityCalRepair"

    suspend fun maybeRun(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ): Boolean = withContext(Dispatchers.IO) {
        val patientId = store.resolvePatientId() ?: return@withContext false
        if (store.getActivityCaloriesRepairAt(patientId) > 0L) return@withContext false
        if (store.getFullBackfillAt(patientId) <= 0L) return@withContext false

        val gaps = ServerBackfillProbe.probeActivityCaloriesGaps(store, http)
        if (gaps.missingCount <= 0) {
            store.setActivityCaloriesRepairAt(patientId, System.currentTimeMillis())
            Log.i(TAG, "Aucun trou récent kcal/effort — réparation ignorée")
            return@withContext false
        }

        Log.i(
            TAG,
            "ACTIVITY_CALORIES_REPAIR début — ${gaps.missingCount} jour(s) (${gaps.missingDays.take(5).joinToString()})",
        )

        val now = System.currentTimeMillis()
        val start = now - TokenStore.RECENT_ACTIVITY_REPAIR_MS
        val payload = repository.collectActivityCaloriesRepairOnly(start, now)
        if (payload.samplesByType.isEmpty() && payload.dailyAggregates.isEmpty()) {
            store.setActivityCaloriesRepairAt(patientId, System.currentTimeMillis())
            Log.i(TAG, "ACTIVITY_CALORIES_REPAIR skip — aucune activité HC sur ${gaps.repairWindowDays} j")
            return@withContext false
        }

        val body = HealthSyncPayloadBuilder.build(
            payload = payload,
            syncId = UUID.randomUUID(),
            phaseLabel = "activity-calories-repair",
            includeDailyAggregates = true,
        )
        body.optJSONObject("fetch")?.put("strategy", "health_connect_activity_calories_repair")

        when (val post = HealthSyncExecutor.postSyncPublic(store, http, body)) {
            is HealthSyncExecutor.PostResult.Success -> {
                store.setActivityCaloriesRepairAt(patientId, System.currentTimeMillis())
                Log.i(
                    TAG,
                    "ACTIVITY_CALORIES_REPAIR ok — inserts=${post.samplesInserted} agg=${post.aggregatesInserted}",
                )
                true
            }
            else -> {
                Log.w(TAG, "ACTIVITY_CALORIES_REPAIR échec")
                false
            }
        }
    }
}
