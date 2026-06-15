import Foundation
import HealthKit

/// Température poignet Apple Watch (Series 8+) — absent du plugin Capgo.
/// Autorisation incluse dans PcpHealthKitAuthorization (une seule feuille).
enum PcpHealthKitWristTemperature {
    private static let store = HKHealthStore()

    static func readSamples(
        start: Date,
        end: Date,
        completion: @escaping ([[String: Any]]) -> Void
    ) {
        readSamplesWithDiagnostics(start: start, end: end) { payload in
            completion(payload["samples"] as? [[String: Any]] ?? [])
        }
    }

    /// Samples + métadonnées pour logs testeur (auth, fenêtre, dernière mesure).
    static func readSamplesWithDiagnostics(
        start: Date,
        end: Date,
        completion: @escaping ([String: Any]) -> Void
    ) {
        if #available(iOS 16.0, *) {
            readSamplesAvailable(start: start, end: end, completion: completion)
        } else {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            DispatchQueue.main.async {
                completion([
                    "samples": [[String: Any]](),
                    "diagnostics": [
                        "count": 0,
                        "hkType": "appleSleepingWristTemperature",
                        "authStatus": -1,
                        "authLabel": "ios_lt_16",
                        "windowStart": formatter.string(from: start),
                        "windowEnd": formatter.string(from: end),
                        "latestStartDate": NSNull(),
                        "error": "appleSleepingWristTemperature requires iOS 16+",
                    ],
                ])
            }
        }
    }

    @available(iOS 16.0, *)
    private static func authLabel(_ status: HKAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .sharingDenied: return "denied"
        case .sharingAuthorized: return "authorized"
        @unknown default: return "unknown(\(status.rawValue))"
        }
    }

    @available(iOS 16.0, *)
    private static func readSamplesAvailable(
        start: Date,
        end: Date,
        completion: @escaping ([String: Any]) -> Void
    ) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        guard HKHealthStore.isHealthDataAvailable(),
              let quantityType = HKObjectType.quantityType(
                  forIdentifier: .appleSleepingWristTemperature
              ) else {
            DispatchQueue.main.async {
                completion([
                    "samples": [[String: Any]](),
                    "diagnostics": [
                        "count": 0,
                        "hkType": "appleSleepingWristTemperature",
                        "authStatus": -1,
                        "authLabel": "type_unavailable",
                        "windowStart": formatter.string(from: start),
                        "windowEnd": formatter.string(from: end),
                        "latestStartDate": NSNull(),
                        "error": "HKQuantityType appleSleepingWristTemperature unavailable",
                    ],
                ])
            }
            return
        }

        let authStatus = store.authorizationStatus(for: quantityType)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let sort = NSSortDescriptor(
            key: HKSampleSortIdentifierStartDate,
            ascending: false
        )
        let query = HKSampleQuery(
            sampleType: quantityType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [sort]
        ) { _, samples, error in
            var errorMessage: String?
            if let error {
                errorMessage = error.localizedDescription
                NSLog("[PcpHealth] wrist temperature query: %@", error.localizedDescription)
            }
            let quantitySamples = samples as? [HKQuantitySample] ?? []
            let count = quantitySamples.count
            NSLog(
                "[PcpHealth] wrist temperature: %d sample(s) %@–%@ auth=%@",
                count,
                formatter.string(from: start),
                formatter.string(from: end),
                authLabel(authStatus)
            )
            let mapped = quantitySamples.map { sample -> [String: Any] in
                let celsius = sample.quantity.doubleValue(for: HKUnit.degreeCelsius())
                let source = sample.sourceRevision.source
                return [
                    "dataType": "bodyTemperature",
                    "value": celsius,
                    "unit": "celsius",
                    "startDate": formatter.string(from: sample.startDate),
                    "endDate": formatter.string(from: sample.endDate),
                    "sourceId": source.bundleIdentifier,
                    "sourceName": source.name,
                    "platformId": sample.uuid.uuidString,
                    "origin": "appleSleepingWristTemperature",
                ]
            }
            let latestStart: Any = quantitySamples.first.map {
                formatter.string(from: $0.startDate)
            } ?? NSNull()
            var sourceCounts: [String: Int] = [:]
            for sample in quantitySamples {
                let name = sample.sourceRevision.source.name
                sourceCounts[name, default: 0] += 1
            }
            var diagnostics: [String: Any] = [
                "count": count,
                "hkType": "appleSleepingWristTemperature",
                "authStatus": authStatus.rawValue,
                "authLabel": authLabel(authStatus),
                "windowStart": formatter.string(from: start),
                "windowEnd": formatter.string(from: end),
                "latestStartDate": latestStart,
                "sources": sourceCounts,
            ]
            if let errorMessage {
                diagnostics["error"] = errorMessage
            }
            DispatchQueue.main.async {
                completion([
                    "samples": mapped,
                    "diagnostics": diagnostics,
                ])
            }
        }
        store.execute(query)
    }
}
