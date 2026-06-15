package com.pcpinnov.pcpttherapy.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import kotlinx.coroutines.runBlocking

/**
 * Permissions Health Connect — alignées [HealthSyncRepository.ALL_READ_PERMISSIONS].
 * Appelé depuis [HealthBridge] (Java) et le launcher Activity Result.
 */
object HealthConnectAuthHelper {

    @JvmStatic
    fun allReadPermissions(): Set<String> = HealthSyncRepository.ALL_READ_PERMISSIONS

    @JvmStatic
    fun countGrantedInSet(granted: Set<String>): Int =
        granted.count { it in ALL_READ_PERMISSIONS }

    @JvmStatic
    fun countGrantedSync(context: Context): Int = runBlocking {
        try {
            val client = HealthConnectClient.getOrCreate(context)
            countGrantedInSet(client.permissionController.getGrantedPermissions())
        } catch (_: Exception) {
            0
        }
    }

    @JvmStatic
    fun readDisplaySnapshotSync(context: Context): String = runBlocking {
        try {
            HealthConnectDisplayReader.readSnapshot(context).toString()
        } catch (e: Exception) {
            org.json.JSONObject().put("error", e.message ?: "snapshot_failed").toString()
        }
    }

    @JvmStatic
    fun hasStepsReadPermissionSync(context: Context): Boolean = runBlocking {
        try {
            val client = HealthConnectClient.getOrCreate(context)
            val granted = client.permissionController.getGrantedPermissions()
            granted.any { perm -> perm.contains("READ_STEPS", ignoreCase = true) }
        } catch (_: Exception) {
            false
        }
    }

    private val ALL_READ_PERMISSIONS: Set<String> = HealthSyncRepository.ALL_READ_PERMISSIONS
}
