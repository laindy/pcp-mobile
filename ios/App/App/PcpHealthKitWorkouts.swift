import Foundation
import HealthKit

/// Séances sport — repli natif (Capgo queryWorkouts renvoie souvent 0 sur l'historique > 60 j).
enum PcpHealthKitWorkouts {
    private static let store = HKHealthStore()

    static func readWorkoutsWithDiagnostics(
        start: Date,
        end: Date,
        completion: @escaping ([String: Any]) -> Void
    ) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        guard HKHealthStore.isHealthDataAvailable() else {
            DispatchQueue.main.async {
                completion(emptyPayload(start: start, end: end, formatter: formatter, error: "HealthKit unavailable"))
            }
            return
        }

        let workoutType = HKObjectType.workoutType()
        let authStatus = store.authorizationStatus(for: workoutType)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

        let query = HKSampleQuery(
            sampleType: workoutType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: [sort]
        ) { _, samples, error in
            var errorMessage: String?
            if let error {
                errorMessage = error.localizedDescription
                NSLog("[PcpHealth] workouts query: %@", error.localizedDescription)
            }
            let workouts = samples as? [HKWorkout] ?? []
            let count = workouts.count
            NSLog(
                "[PcpHealth] workouts natif: %d séance(s) %@–%@ auth=%@",
                count,
                formatter.string(from: start),
                formatter.string(from: end),
                authLabel(authStatus)
            )

            let kcalUnit = HKUnit.kilocalorie()
            let meterUnit = HKUnit.meter()
            let mapped = workouts.map { workout -> [String: Any] in
                let source = workout.sourceRevision.source
                let energy = workout.totalEnergyBurned?.doubleValue(for: kcalUnit)
                let distance = workout.totalDistance?.doubleValue(for: meterUnit)
                return [
                    "workoutType": workoutTypeName(workout.workoutActivityType),
                    "activityType": workoutTypeName(workout.workoutActivityType),
                    "duration": Int(workout.duration.rounded()),
                    "totalEnergyBurned": energy as Any,
                    "totalDistance": distance as Any,
                    "startDate": formatter.string(from: workout.startDate),
                    "endDate": formatter.string(from: workout.endDate),
                    "sourceId": source.bundleIdentifier,
                    "sourceName": source.name,
                    "platformId": workout.uuid.uuidString,
                ]
            }

            var typeCounts: [String: Int] = [:]
            for w in mapped {
                let t = w["workoutType"] as? String ?? "unknown"
                typeCounts[t, default: 0] += 1
            }

            var diagnostics: [String: Any] = [
                "count": count,
                "hkType": "HKWorkoutTypeIdentifier",
                "authStatus": authStatus.rawValue,
                "authLabel": authLabel(authStatus),
                "windowStart": formatter.string(from: start),
                "windowEnd": formatter.string(from: end),
                "types": typeCounts,
            ]
            if let errorMessage {
                diagnostics["error"] = errorMessage
            }
            DispatchQueue.main.async {
                completion([
                    "workouts": mapped,
                    "diagnostics": diagnostics,
                ])
            }
        }
        store.execute(query)
    }

    private static func emptyPayload(
        start: Date,
        end: Date,
        formatter: ISO8601DateFormatter,
        error: String
    ) -> [String: Any] {
        [
            "workouts": [[String: Any]](),
            "diagnostics": [
                "count": 0,
                "hkType": "HKWorkoutTypeIdentifier",
                "authStatus": -1,
                "authLabel": "unavailable",
                "windowStart": formatter.string(from: start),
                "windowEnd": formatter.string(from: end),
                "error": error,
            ],
        ]
    }

    private static func workoutTypeName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "running"
        case .walking: return "walking"
        case .cycling: return "cycling"
        case .swimming: return "swimming"
        case .hiking: return "hiking"
        case .yoga: return "yoga"
        case .functionalStrengthTraining: return "functionalStrengthTraining"
        case .traditionalStrengthTraining: return "traditionalStrengthTraining"
        case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
        case .elliptical: return "elliptical"
        case .stairClimbing: return "stairClimbing"
        case .rowing: return "rowing"
        case .crossTraining: return "crossTraining"
        case .mixedCardio: return "mixedCardio"
        case .coreTraining: return "coreTraining"
        case .pilates: return "pilates"
        case .dance: return "dance"
        case .cooldown: return "cooldown"
        case .other: return "other"
        default: return "other_\(type.rawValue)"
        }
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
