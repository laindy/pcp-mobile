package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.atomic.AtomicBoolean

/** Réparation stades sommeil non bloquante — aligné iOS [runBackgroundSleepStagesRepair]. */
object BackgroundSleepStagesRepair {

    private const val TAG = "BgSleepStagesRepair"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = AtomicBoolean(false)

    fun enqueue(
        context: Context,
        store: TokenStore,
        repository: HealthSyncRepository,
        http: OkHttpClient,
    ) {
        if (!running.compareAndSet(false, true)) {
            Log.i(TAG, "Réparation sommeil stades déjà en cours (arrière-plan)")
            return
        }
        val app = context.applicationContext
        scope.launch {
            try {
                Log.i(TAG, "SLEEP_STAGES_REPAIR background démarré")
                HealthBridge.logToJs("[sync-session] SLEEP_STAGES_REPAIR background démarré")
                SleepStagesRepairExecutor.maybeRun(app, store, repository, http)
            } catch (e: Exception) {
                Log.w(TAG, "Sleep stages repair background: ${e.message}")
            } finally {
                running.set(false)
            }
        }
    }
}
