package com.pcpinnov.pcpttherapy;

import android.util.Log;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.pcpinnov.pcpttherapy.health.HealthBridge;
import org.json.JSONObject;

/**
 * Activité de test isolée qui charge la page locale {@code public/health.html}
 * bundlée dans l'APK, pour tester l'accès Apple HealthKit / Android Health Connect
 * via {@code @capgo/capacitor-health}.
 *
 * Contrairement à {@link MainActivity}, cette activité n'utilise pas le
 * {@code server.url} distant — la page est servie depuis les assets locaux par
 * Capacitor sur {@code https://localhost/health.html}.
 *
 * On active aussi {@code CapacitorHttp} ici pour que les appels {@code fetch}
 * vers le backend (https://patient.pcpinnov.com/api/...) passent par le pont
 * natif et contournent les restrictions CORS imposées par l'origine
 * {@code https://localhost}.
 */
public class HealthTestActivity extends BridgeActivity {

    @Override
    protected void load() {
        JSONObject pluginsConfig = new JSONObject();
        try {
            JSONObject httpConfig = new JSONObject();
            httpConfig.put("enabled", true);
            pluginsConfig.put("CapacitorHttp", httpConfig);
        } catch (Exception e) {
            Log.w("HealthTestActivity", "Failed to build CapacitorHttp config", e);
        }

        this.config = new CapConfig.Builder(this)
            .setStartPath("/health.html")
            .setPluginsConfiguration(pluginsConfig)
            .create();
        super.load();
        bridge.getWebView().addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        // Expose le bridge santé natif aussi sur la page de test : utile pour
        // déclencher manuellement la sync depuis le panneau debug.
        bridge.getWebView().addJavascriptInterface(new HealthBridge(this, bridge.getWebView()), HealthBridge.JS_NAME);
    }

    /** Exposé à la page web via window.AndroidBridge. */
    public class AndroidBridge {
        @JavascriptInterface
        public void close() {
            runOnUiThread(HealthTestActivity.this::finish);
        }
    }
}
