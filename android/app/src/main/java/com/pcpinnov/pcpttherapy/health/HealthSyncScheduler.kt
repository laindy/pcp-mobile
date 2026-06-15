package com.pcpinnov.pcpttherapy.health

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Data
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Façade qui planifie et déclenche [HealthSyncWorker].
 *
 * Deux modes :
 * - **Périodique** : 1× toutes les 6h (ExistingPeriodicWorkPolicy.KEEP — on ne
 *   réinitialise pas le compteur si déjà planifié). Démarré au login (cf.
 *   [HealthBridge.setToken]) et au boot de l'app si un token existe déjà.
 * - **One-shot** : déclenché manuellement (page de test debug, ou frontend
 *   après une action utilisateur). [ExistingWorkPolicy.REPLACE] pour qu'un
 *   nouveau trigger annule le précédent en cours.
 *
 * Contraintes : réseau requis (CONNECTED) — HC peut être lue sans réseau mais
 * l'envoi backend nécessite une connectivité, autant attendre.
 */
object HealthSyncScheduler {

    private val CONSTRAINTS = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /** Planifie le job périodique 6h. KEEP : ne reset pas si déjà planifié. */
    fun enqueuePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<HealthSyncWorker>(6, TimeUnit.HOURS)
            .setConstraints(CONSTRAINTS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            HealthSyncWorker.WORK_NAME_PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** Annule la sync périodique (au logout par exemple). */
    fun cancelPeriodic(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(HealthSyncWorker.WORK_NAME_PERIODIC)
    }

    /** Déclenche une sync immédiate (réseau requis, retry exponentiel si fail). */
    fun enqueueOneShot(context: Context, forceFullLookback: Boolean = true) {
        val input = Data.Builder()
            .putBoolean(HealthSyncWorker.INPUT_FORCE_FULL, forceFullLookback)
            .build()
        val request = OneTimeWorkRequestBuilder<HealthSyncWorker>()
            .setInputData(input)
            .setConstraints(CONSTRAINTS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            HealthSyncWorker.WORK_NAME_ONESHOT,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

}
