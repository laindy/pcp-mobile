package com.pcpinnov.pcpttherapy.health

import android.util.Base64
import org.json.JSONObject

object JwtPatientId {
    fun fromToken(token: String?): String? {
        if (token.isNullOrBlank()) return null
        val parts = token.split(".")
        if (parts.size < 2) return null
        return try {
            val decoded = Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            val json = JSONObject(String(decoded, Charsets.UTF_8))
            json.optString("sub", "").takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }
    }
}
