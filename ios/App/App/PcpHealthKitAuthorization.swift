import Foundation
import HealthKit

/// Demande lecture HealthKit en une seule feuille — types alignés frontend + backend uniquement.
enum PcpHealthKitAuthorization {
    private static let store = HKHealthStore()

    static func requestAllReadTypes(completion: @escaping (Bool) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else {
            DispatchQueue.main.async { completion(false) }
            return
        }

        var readTypes = Set<HKObjectType>()

        func addQuantity(_ id: HKQuantityTypeIdentifier) {
            if let type = HKObjectType.quantityType(forIdentifier: id) {
                readTypes.insert(type)
            }
        }

        func addCategory(_ id: HKCategoryTypeIdentifier) {
            if let type = HKObjectType.categoryType(forIdentifier: id) {
                readTypes.insert(type)
            }
        }

        // Aligné sur health-ios-sync.js HEALTH_READ_PERMS
        addQuantity(.stepCount)
        addQuantity(.activeEnergyBurned)
        addCategory(.sleepAnalysis)
        addQuantity(.respiratoryRate)
        addQuantity(.oxygenSaturation)
        addQuantity(.restingHeartRate)
        addQuantity(.heartRateVariabilitySDNN)
        addQuantity(.bodyTemperature)
        addQuantity(.basalBodyTemperature)
        addQuantity(.heartRate)
        addQuantity(.vo2Max)
        addCategory(.mindfulSession)
        readTypes.insert(HKObjectType.workoutType())

        if #available(iOS 16.0, *) {
            addQuantity(.appleSleepingWristTemperature)
        }

        guard !readTypes.isEmpty else {
            DispatchQueue.main.async { completion(false) }
            return
        }

        NSLog("[PcpHealth] requestAuthorization lecture groupée (%d types)", readTypes.count)
        store.requestAuthorization(toShare: Set<HKSampleType>(), read: readTypes) { ok, error in
            if let error {
                NSLog("[PcpHealth] auth groupée erreur: %@", error.localizedDescription)
            }
            DispatchQueue.main.async { completion(ok) }
        }
    }

    /// Types absents de Capgo iOS — si `notDetermined`, la feuille native n'a pas été acceptée.
    static func nativeOnlyTypesPending() -> [String: String] {
        guard HKHealthStore.isHealthDataAvailable() else { return [:] }

        var pending: [String: String] = [:]
        if let vo2 = HKObjectType.quantityType(forIdentifier: .vo2Max),
           store.authorizationStatus(for: vo2) == .notDetermined {
            pending["vo2Max"] = "notDetermined"
        }
        if #available(iOS 16.0, *) {
            if let wrist = HKObjectType.quantityType(forIdentifier: .appleSleepingWristTemperature),
               store.authorizationStatus(for: wrist) == .notDetermined {
                pending["appleSleepingWristTemperature"] = "notDetermined"
            }
        }
        return pending
    }

    static func hasNativeOnlyTypesPending() -> Bool {
        !nativeOnlyTypesPending().isEmpty
    }
}
