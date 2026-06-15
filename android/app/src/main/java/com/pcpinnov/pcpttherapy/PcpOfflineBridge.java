package com.pcpinnov.pcpttherapy;

import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

/**
 * Pont JS minimal pour {@code offline.html} — recharge l'URL distante de l'app.
 */
public final class PcpOfflineBridge {

    public static final String JS_NAME = "PcpOfflineBridge";
    public static final String APP_URL = "https://patient.pcpinnov.com/";

    private final BridgeActivity activity;

    public PcpOfflineBridge(BridgeActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void reloadApp() {
        activity.runOnUiThread(() -> {
            if (activity.getBridge() == null || activity.getBridge().getWebView() == null) {
                return;
            }
            activity.getBridge().getWebView().loadUrl(APP_URL);
        });
    }
}
