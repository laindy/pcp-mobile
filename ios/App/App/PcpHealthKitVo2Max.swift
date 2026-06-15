import Foundation
import HealthKit

/// VO₂ max Apple Watch / cardio — repli natif si Capgo échoue ou renvoie 0 sample.
enum PcpHealthKitVo2Max {
    private static let store = HKHealthStore()

    static func readSamplesWithDiagnostics(
        start: Date,
        end: Date,
        completion: @escaping ([String: Any]) -> Void
    ) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        guard HKHealthStore.isHealthDataAvailable(),
              let quantityType = HKObjectType.quantityType(forIdentifier: .vo2Max) else {
            DispatchQueue.main.async {
                completion([
                    "samples": [[String: Any]](),
                    "diagnostics": [
                        "count": 0,
                        "hkType": "HKQuantityTypeIdentifierVO2Max",
                        "authStatus": -1,
                        "authLabel": "type_unavailable",
                        "windowStart": formatter.string(from: start),
                        "windowEnd": formatter.string(from: end),
                        "latestStartDate": NSNull(),
                        "error": "HKQuantityType vo2Max unavailable",
                    ],
                ])
            }
            return
        }

        let authStatus = store.authorizationStatus(for: quantityType)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        let vo2Unit = HKUnit(from: "ml/kg*min")

        let query = HKSampleQuery(
            sampleType: quantityType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [sort]
        ) { _, samples, error in
            var errorMessage: String?
            if let error {
                errorMessage = error.localizedDescription
                NSLog("[PcpHealth] vo2Max query: %@", error.localizedDescription)
            }
            let quantitySamples = samples as? [HKQuantitySample] ?? []
            let count = quantitySamples.count
            NSLog(
                "[PcpHealth] vo2Max natif: %d sample(s) %@–%@ auth=%@",
                count,
                formatter.string(from: start),
                formatter.string(from: end),
                authLabel(authStatus)
            )
            let mapped = quantitySamples.map { sample -> [String: Any] in
                let mlPerKgMin = sample.quantity.doubleValue(for: vo2Unit)
                let source = sample.sourceRevision.source
                return [
                    "dataType": "vo2Max",
                    "value": mlPerKgMin,
                    "unit": "milliliterPerKilogramPerMinute",
                    "startDate": formatter.string(from: sample.startDate),
                    "endDate": formatter.string(from: sample.endDate),
                    "sourceId": source.bundleIdentifier,
                    "sourceName": source.name,
                    "platformId": sample.uuid.uuidString,
                    "origin": "HKQuantityTypeIdentifierVO2Max",
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
                "hkType": "HKQuantityTypeIdentifierVO2Max",
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

    private static func authLabel(_ status: HKAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "write_notDetermined"
        case .sharingDenied: return "write_denied"
        case .sharingAuthorized: return "write_authorized"
        @unknown default: return "unknown(\(status.rawValue))"
        }
    }
}
