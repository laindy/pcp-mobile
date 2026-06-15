import Foundation

/// État sync santé par patient (backfill 60 j, dernière sync) — survit au reload WKWebView.
enum HealthSyncStateStore {
    private static let prefix = "pcp_health_sync_state_"

    private static func storageKey(patientId: String) -> String {
        prefix + patientId
    }

    static func getState(patientId: String) -> [String: String] {
        guard !patientId.isEmpty else { return [:] }
        guard let raw = UserDefaults.standard.dictionary(forKey: storageKey(patientId: patientId)) else {
            return [:]
        }
        var out: [String: String] = [:]
        for (key, value) in raw {
            if let s = value as? String {
                out[key] = s
            } else if let n = value as? NSNumber {
                out[key] = n.stringValue
            }
        }
        return out
    }

    static func setField(patientId: String, key: String, value: String?) {
        guard !patientId.isEmpty, !key.isEmpty else { return }
        let storeKey = storageKey(patientId: patientId)
        var state = getState(patientId: patientId)
        if let value, !value.isEmpty {
            state[key] = value
        } else {
            state.removeValue(forKey: key)
        }
        if state.isEmpty {
            UserDefaults.standard.removeObject(forKey: storeKey)
        } else {
            UserDefaults.standard.set(state, forKey: storeKey)
        }
    }

    static func clearPatient(patientId: String) {
        guard !patientId.isEmpty else { return }
        UserDefaults.standard.removeObject(forKey: storageKey(patientId: patientId))
    }
}
