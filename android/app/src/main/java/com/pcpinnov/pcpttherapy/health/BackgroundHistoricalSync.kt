package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Backfill historique (j 8–60) en arrière-plan après phase récente — aligné iOS
 * [runBackgroundHistoricalBackfill].
 */
object BackgroundHistoricalSync {

    private const val TAG = "BgHistoricalSync"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun enqueue(context: Context, phases: List<TokenStore.SyncPhase>) {
        if (phases.isEmpty()) return
        val app = context.applicationContext
        scope.launch {
            Log.i(TAG, "BACKFILL_ARRIÈRE_PLAN démarré (${phases.size} phase(s))")
            when (HealthSyncExecutor.runHistoricalPhases(app, phases)) {
                HealthSyncExecutor.Outcome.SUCCESS ->
                    Log.i(TAG, "BACKFILL_ARRIÈRE_PLAN terminé")
                HealthSyncExecutor.Outcome.RETRY ->
                    Log.w(TAG, "BACKFILL_ARRIÈRE_PLAN — retry suggéré")
                HealthSyncExecutor.Outcome.TERMINAL ->
                    Log.w(TAG, "BACKFILL_ARRIÈRE_PLAN terminé (terminal)")
            }
        }
    }
}
