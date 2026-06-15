package com.pcpinnov.pcpttherapy;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

/**
 * Health Connect exige qu'une activité de l'app réponde à l'intent
 * {@code androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE} (ainsi qu'à
 * {@code android.intent.action.VIEW_PERMISSION_USAGE} sur Android 14+).
 * Sans cette activité, Health Connect refuse d'accorder les permissions
 * health.READ_* / health.WRITE_* avec l'erreur « is not declared ».
 *
 * On affiche la page locale {@code public/privacypolicy.html} bundlée dans
 * l'APK (servie depuis {@code file:///android_asset/public/}).
 */
public class PermissionsRationaleActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        webView.getSettings().setJavaScriptEnabled(false);
        webView.loadUrl("file:///android_asset/public/privacypolicy.html");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.addView(
            webView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        setContentView(root);
    }
}
