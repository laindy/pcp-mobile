package com.pcpinnov.pcpttherapy.health

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Sync manuelle (swipe) — lecture HC au premier plan via coroutine dédiée.
 * WorkManager reste réservé à la sync périodique 6 h.
 */
object ForegroundHealthSync {

    private const val TAG = "ForegroundHealthSync"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = AtomicBoolean(false)

    @JvmStatic
    fun enqueue(context: Context) {
        if (!running.compareAndSet(false, true)) {
            Log.i(TAG, "Sync foreground déjà en cours — ignorée")
            return
        }
        val app = context.applicationContext
        scope.launch {
            try {
                when (HealthSyncExecutor.run(app, foreground = true)) {
                    HealthSyncExecutor.Outcome.SUCCESS ->
                        Log.i(TAG, "Sync foreground terminée")
                    HealthSyncExecutor.Outcome.RETRY ->
                        Log.w(TAG, "Sync foreground — retry suggéré")
                    HealthSyncExecutor.Outcome.TERMINAL ->
                        Log.w(TAG, "Sync foreground terminée (terminal)")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Sync foreground échouée: ${e.message}", e)
                TokenStore(app).setLastSyncError(e.message)
            } finally {
                running.set(false)
            }
        }
    }
}
