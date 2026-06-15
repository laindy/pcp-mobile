import Foundation
import WebKit

/// Utilitaires pour la page hors-ligne bundlée (`public/offline.html`).
/// Le chargement est géré par Capacitor via `server.errorPath` dans capacitor.config.
enum PcpOfflinePage {
    static let appURL = URL(string: "https://patient.pcpinnov.com/")!

    static func isOfflinePage(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.lastPathComponent == "offline.html" || url.path.hasSuffix("/offline.html")
    }

    static func reloadApp(in webView: WKWebView) {
        webView.stopLoading()
        webView.load(URLRequest(url: appURL))
    }
}
