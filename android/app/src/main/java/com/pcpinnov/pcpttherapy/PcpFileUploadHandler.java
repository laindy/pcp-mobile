package com.pcpinnov.pcpttherapy;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.lang.ref.WeakReference;

/**
 * Caméra + galerie pour avatar profil — parité iOS {@code pcpPickImage}.
 */
public class PcpFileUploadHandler {

    private static final String TAG = "PcpFileUpload";
    public static final String JS_NAME = "PcpFileUploadBridge";

    private final WeakReference<ComponentActivity> activityRef;
    private WeakReference<WebView> webViewRef;
    private Uri cameraOutputUri;
    private ValueCallback<Uri[]> pendingFileCallback;
    private String pendingImageB64;
    private String pendingImageMime = "image/jpeg";
    private String pendingImageName = "photo.jpg";

    private ActivityResultLauncher<Intent> pickerLauncher;
    private ActivityResultLauncher<Intent> cameraLauncher;
    private ActivityResultLauncher<String> cameraPermissionLauncher;

    public PcpFileUploadHandler(ComponentActivity activity) {
        this.activityRef = new WeakReference<>(activity);
        this.webViewRef = new WeakReference<>(null);
        registerLaunchers(activity);
    }

    public void attachWebView(WebView webView) {
        this.webViewRef = new WeakReference<>(webView);
    }

    private void registerLaunchers(ComponentActivity activity) {
        cameraPermissionLauncher = activity.registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            granted -> {
                if (granted) {
                    launchCameraIntent();
                } else {
                    Log.w(TAG, "Permission CAMERA refusée — fallback galerie");
                    launchGallery();
                }
            }
        );
        pickerLauncher = activity.registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() != Activity.RESULT_OK) {
                    cancelPendingCallback();
                    return;
                }
                Uri uri = result.getData() != null ? result.getData().getData() : null;
                if (uri != null) {
                    deliverImageFromUri(uri);
                } else {
                    cancelPendingCallback();
                }
            }
        );
        cameraLauncher = activity.registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (result.getResultCode() != Activity.RESULT_OK || cameraOutputUri == null) {
                    cancelPendingCallback();
                    return;
                }
                deliverImageFromUri(cameraOutputUri);
            }
        );
    }

    /** Fallback WebChromeClient — retourne true si géré. */
    public boolean handleShowFileChooser(
        ValueCallback<Uri[]> filePathCallback,
        WebChromeClient.FileChooserParams fileChooserParams
    ) {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
        }
        pendingFileCallback = filePathCallback;
        ComponentActivity activity = activityRef.get();
        if (activity == null || activity.isFinishing()) {
            cancelPendingCallback();
            return false;
        }
        activity.runOnUiThread(this::showPickerDialog);
        return true;
    }

    @JavascriptInterface
    public void pickImage() {
        pendingFileCallback = null;
        ComponentActivity activity = activityRef.get();
        if (activity == null || activity.isFinishing()) {
            return;
        }
        activity.runOnUiThread(this::showPickerDialog);
    }

    /** Image base64 consommée par le JS injecté (évite les strings géantes dans evaluateJavascript). */
    @JavascriptInterface
    public String consumePickedImage() {
        String b64 = pendingImageB64;
        pendingImageB64 = null;
        return b64 != null ? b64 : "";
    }

    @JavascriptInterface
    public String consumePickedImageMime() {
        String mime = pendingImageMime;
        pendingImageMime = "image/jpeg";
        return mime != null ? mime : "image/jpeg";
    }

    @JavascriptInterface
    public String consumePickedImageName() {
        String name = pendingImageName;
        pendingImageName = "photo.jpg";
        return name != null ? name : "photo.jpg";
    }

    private void showPickerDialog() {
        ComponentActivity activity = activityRef.get();
        if (activity == null) {
            cancelPendingCallback();
            return;
        }
        try {
            new AlertDialog.Builder(activity)
                .setTitle("Photo de profil")
                .setItems(
                    new String[] { "Appareil photo", "Bibliothèque photos" },
                    (dialog, which) -> {
                        if (which == 0) {
                            launchCamera();
                        } else {
                            launchGallery();
                        }
                    }
                )
                .setNegativeButton("Annuler", (d, w) -> cancelPendingCallback())
                .setOnCancelListener(d -> cancelPendingCallback())
                .show();
        } catch (Throwable t) {
            Log.w(TAG, "pickImage dialog failed: " + t.getMessage());
            launchGallery();
        }
    }

    private void launchGallery() {
        ComponentActivity activity = activityRef.get();
        if (activity == null) {
            cancelPendingCallback();
            return;
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        pickerLauncher.launch(Intent.createChooser(intent, "Choisir une photo"));
    }

    private void launchCamera() {
        ComponentActivity activity = activityRef.get();
        if (activity == null) {
            cancelPendingCallback();
            return;
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
            return;
        }
        launchCameraIntent();
    }

    private void launchCameraIntent() {
        ComponentActivity activity = activityRef.get();
        if (activity == null) {
            cancelPendingCallback();
            return;
        }
        try {
            File photoFile = new File(
                activity.getCacheDir(),
                "pcp-camera-" + System.currentTimeMillis() + ".jpg"
            );
            cameraOutputUri = FileProvider.getUriForFile(
                activity,
                activity.getPackageName() + ".fileprovider",
                photoFile
            );
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            cameraLauncher.launch(intent);
        } catch (Throwable t) {
            Log.w(TAG, "Camera launch failed: " + t.getMessage());
            launchGallery();
        }
    }

    private void deliverImageFromUri(Uri uri) {
        ComponentActivity activity = activityRef.get();
        WebView webView = webViewRef.get();
        if (activity == null) {
            cancelPendingCallback();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                byte[] jpeg = readAndCompressJpeg(activity, uri);
                if (jpeg == null || jpeg.length == 0) {
                    cancelPendingCallback();
                    return;
                }
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(new Uri[] { uri });
                    pendingFileCallback = null;
                    return;
                }
                pendingImageB64 = Base64.encodeToString(jpeg, Base64.NO_WRAP);
                pendingImageMime = "image/jpeg";
                pendingImageName = "photo.jpg";
                if (webView != null) {
                    webView.evaluateJavascript(
                        "window.__pcpApplyPickedFileFromBridge&&window.__pcpApplyPickedFileFromBridge();",
                        null
                    );
                }
            } catch (Throwable t) {
                Log.e(TAG, "deliverImageFromUri failed", t);
                cancelPendingCallback();
            }
        });
    }

    private void cancelPendingCallback() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
        pendingImageB64 = null;
    }

    private static byte[] readAndCompressJpeg(ComponentActivity activity, Uri uri) throws Exception {
        Bitmap bitmap;
        try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
            if (in == null) {
                return null;
            }
            bitmap = BitmapFactory.decodeStream(in);
        }
        if (bitmap == null) {
            return null;
        }
        int maxDim = 2048;
        int w = bitmap.getWidth();
        int h = bitmap.getHeight();
        float scale = 1f;
        if (Math.max(w, h) > maxDim) {
            scale = maxDim / (float) Math.max(w, h);
        }
        Bitmap scaled = bitmap;
        if (scale < 1f) {
            int nw = Math.round(w * scale);
            int nh = Math.round(h * scale);
            scaled = Bitmap.createScaledBitmap(bitmap, nw, nh, true);
            if (scaled != bitmap) {
                bitmap.recycle();
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, 88, out);
        if (scaled != bitmap) {
            scaled.recycle();
        }
        return out.toByteArray();
    }
}
