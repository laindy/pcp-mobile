package com.pcpinnov.pcpttherapy;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import androidx.activity.result.ActivityResultLauncher;
import androidx.health.connect.client.PermissionController;
import java.util.Set;
import com.getcapacitor.BridgeActivity;
import com.pcpinnov.pcpttherapy.health.HealthBridge;
import com.pcpinnov.pcpttherapy.health.HealthSyncScheduler;
import com.pcpinnov.pcpttherapy.health.SessionInterceptor;
import com.pcpinnov.pcpttherapy.health.TokenStore;

import android.os.Build;
import android.webkit.WebSettings;

/**
 * Activité principale — héberge la WebView Capacitor pointée sur
 * {@code https://patient.pcpinnov.com}.
 *
 * Couche santé automatique (zéro touch utilisateur) :
 *   1. Expose {@code window.PcpHealthBridge} (cf. {@link HealthBridge})
 *   2. Installe un {@link SessionInterceptor} qui injecte un script JS à
 *      chaque chargement de page : il poll {@code /api/auth/session} NextAuth
 *      et transmet le {@code accessToken} au natif → planifie la sync
 *      périodique + demande les permissions Health Connect après le login.
 *   3. Si un token est déjà persistant (relance de l'app), s'assure que la
 *      sync périodique 6h est planifiée immédiatement.
 *
 * <p>Le bouton flottant « Test Santé » est laissé en commentaire — il sert
 * uniquement pendant le développement pour ouvrir la page debug locale
 * {@code public/health.html}.</p>
 */
public class MainActivity extends BridgeActivity {

    private PcpFileUploadHandler fileUploadHandler;
    private HealthBridge healthBridge;
    private ActivityResultLauncher<java.util.Set<String>> hcPermissionLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // ActivityResultLauncher doit être enregistré avant super.onCreate().
        hcPermissionLauncher = registerForActivityResult(
            PermissionController.createRequestPermissionResultContract(),
            granted -> {
                if (healthBridge != null) {
                    healthBridge.onHealthConnectPermissionsResult(granted);
                }
            }
        );
        fileUploadHandler = new PcpFileUploadHandler(this);
        super.onCreate(savedInstanceState);

        android.webkit.WebView webView = bridge.getWebView();
        WebSettings webSettings = webView.getSettings();
        if (webSettings != null) {
            // Ignore system font scale — match design px (otherwise text looks oversized).
            webSettings.setTextZoom(100);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                webSettings.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                webSettings.setAlgorithmicDarkeningAllowed(false);
            }
        }
        fileUploadHandler.attachWebView(webView);
        webView.addJavascriptInterface(fileUploadHandler, PcpFileUploadHandler.JS_NAME);

        // Bridge natif exposé au JS de la WebView (frontend Next.js).
        healthBridge = new HealthBridge(this, webView);
        healthBridge.attachPermissionLauncher(hcPermissionLauncher);
        webView.addJavascriptInterface(healthBridge, HealthBridge.JS_NAME);
        webView.addJavascriptInterface(new PcpOfflineBridge(this), PcpOfflineBridge.JS_NAME);

        // Hooke l'auth NextAuth — récupère le token automatiquement après login,
        // demande les permissions HC et déclenche la sync. Aucune modif frontend.
        webView.setWebViewClient(new SessionInterceptor(bridge));
        webView.setWebChromeClient(new PcpWebChromeClient(bridge, fileUploadHandler));

        // Si un token est déjà persistant (relance de l'app), planifie la sync
        // périodique 6h tout de suite. KEEP policy → no-op si déjà active.
        if (new TokenStore(this).getToken() != null) {
            HealthSyncScheduler.INSTANCE.enqueuePeriodic(this);
        }

        // DEBUG ONLY — décommenter pour réafficher le bouton flottant qui ouvre
        // HealthTestActivity (visualisation des données backend, sync manuelle).
        // En production la sync tourne toute seule en arrière-plan, l'utilisateur
        // final n'a aucune UI santé dans l'app native.
        // addHealthDebugButton();
    }

    // ─────────────────────────────────────────────────────────────────────
    // FAB "Debug santé" — uniquement pour le développement.
    // Ouvre HealthTestActivity → page health.html qui sert de panneau debug
    // (visualisation des données backend, déclenchement manuel de sync, etc.).
    // Décommenter l'appel addHealthDebugButton() ci-dessus pour réactiver.
    // ─────────────────────────────────────────────────────────────────────
    @SuppressWarnings("unused")
    private void addHealthDebugButton() {
        Button btn = new Button(this);
        btn.setText("Debug santé");
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        btn.setAllCaps(false);
        btn.setElevation(dp(4f));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xCC0F172A); // bleu nuit semi-transparent — discret
        bg.setCornerRadius(dp(20f));
        btn.setBackground(bg);

        int padH = (int) dp(12f);
        int padV = (int) dp(6f);
        btn.setPadding(padH, padV, padH, padV);

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = Gravity.BOTTOM | Gravity.END;
        params.bottomMargin = (int) dp(80f);
        params.rightMargin = (int) dp(12f);
        btn.setLayoutParams(params);

        btn.setOnClickListener(v ->
            startActivity(new Intent(this, HealthTestActivity.class)));

        ViewGroup root = (ViewGroup) findViewById(android.R.id.content);
        if (root != null) {
            root.addView(btn);
        }
    }

    private float dp(float value) {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }
}
