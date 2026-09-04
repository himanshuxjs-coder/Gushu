package com.gushu.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private View offlineLayout;
    private WebView webView;
    private TextView descriptionText;
    private Button retryButton;
    private Handler handler = new Handler(Looper.getMainLooper());
    private boolean isErrorShown = false;
    private boolean isPageLoaded = false;
    private static final int LOAD_TIMEOUT_MS = 15000;
    private long lastReloadTime = 0;
    private static final int PERMISSIONS_REQUEST_CODE = 123;
    private PermissionRequest pendingPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Let Capacitor initialize its bridge and WebView
        // After super.onCreate, this.bridge is available.
        webView = this.bridge.getWebView();

        // 2. Inflate and Inject Offline Layout on top of the root view
        offlineLayout = getLayoutInflater().inflate(R.layout.layout_offline, null);
        addContentView(offlineLayout, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        
        descriptionText = offlineLayout.findViewById(R.id.offline_description);
        retryButton = offlineLayout.findViewById(R.id.btn_retry);

        // 3. Setup Retry Logic
        retryButton.setOnClickListener(v -> {
            if (isNetworkAvailable()) {
                restartApp();
            } else {
                Toast.makeText(this, "No internet connection available.", Toast.LENGTH_SHORT).show();
            }
        });

        // 4. Setup Custom WebView Error Handling
        setupWebView();

        // 5. Setup Connectivity Monitoring (Automatic Recovery)
        registerNetworkCallback();

        // 6. Start Startup Timeout Protection
        startTimeoutTimer();

        // 7. Request permissions on startup
        checkAndRequestStartupPermissions();
    }

    private void setupWebView() {
        // Inject our client into the bridge's WebView
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                isPageLoaded = true;
                if (!isErrorShown) {
                    hideOfflineScreen();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only handle main frame failures (initial load or navigation)
                if (request.isForMainFrame()) {
                    showOfflineScreen("Unable to connect", "Please check your internet connection and try again.");
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse.getStatusCode() >= 400) {
                    showOfflineScreen("Service Unavailable", "The Gushu server is currently unreachable. Please try again later.");
                }
            }

            @Override
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                showOfflineScreen("Security Error", "A secure connection to Gushu could not be established.");
                handler.cancel();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                pendingPermissionRequest = request;
                String[] resources = request.getResources();
                List<String> permissionsNeeded = new ArrayList<>();

                for (String resource : resources) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        permissionsNeeded.add(Manifest.permission.CAMERA);
                    } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        permissionsNeeded.add(Manifest.permission.RECORD_AUDIO);
                    }
                }

                if (!permissionsNeeded.isEmpty()) {
                    ActivityCompat.requestPermissions(MainActivity.this,
                            permissionsNeeded.toArray(new String[0]), PERMISSIONS_REQUEST_CODE);
                } else {
                    request.grant(resources);
                }
            }
        });
    }

    private void checkAndRequestStartupPermissions() {
        List<String> permissionsNeeded = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissionsNeeded.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionsNeeded.add(Manifest.permission.RECORD_AUDIO);
        }

        if (!permissionsNeeded.isEmpty()) {
            ActivityCompat.requestPermissions(this, permissionsNeeded.toArray(new String[0]), PERMISSIONS_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSIONS_REQUEST_CODE) {
            if (pendingPermissionRequest != null) {
                List<String> grantedResources = new ArrayList<>();
                for (int i = 0; i < permissions.length; i++) {
                    if (grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                        if (Manifest.permission.CAMERA.equals(permissions[i])) {
                            grantedResources.add(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
                        } else if (Manifest.permission.RECORD_AUDIO.equals(permissions[i])) {
                            grantedResources.add(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
                        }
                    }
                }
                
                if (!grantedResources.isEmpty()) {
                    pendingPermissionRequest.grant(grantedResources.toArray(new String[0]));
                } else {
                    pendingPermissionRequest.deny();
                }
                pendingPermissionRequest = null;
            }
        }
    }

    private void startTimeoutTimer() {
        handler.postDelayed(() -> {
            if (!isPageLoaded && !isErrorShown) {
                showOfflineScreen("Unable to connect", "Still trying to connect to Gushu.");
            }
        }, LOAD_TIMEOUT_MS);
    }

    private void showOfflineScreen(String title, String description) {
        if (isErrorShown && title.equals("Unable to connect") && description.contains("Still trying")) {
            return;
        }
        
        isErrorShown = true;
        isPageLoaded = false;
        runOnUiThread(() -> {
            TextView titleView = offlineLayout.findViewById(R.id.offline_title);
            titleView.setText(title);
            descriptionText.setText(description);
            offlineLayout.setVisibility(View.VISIBLE);
            // Use INVISIBLE instead of GONE so the WebView stays in the view hierarchy
            webView.setVisibility(View.INVISIBLE);
        });
    }

    private void hideOfflineScreen() {
        isErrorShown = false;
        runOnUiThread(() -> {
            offlineLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
        });
    }

    private void restartApp() {
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastReloadTime < 5000) return; // Debounce restarts
        
        lastReloadTime = currentTime;
        isPageLoaded = false;

        runOnUiThread(() -> {
            android.util.Log.d("Gushu", "Restarting Activity...");
            // recreate() is a native Android way to destroy and restart the current activity
            this.recreate();
        });
    }

    private void registerNetworkCallback() {
        ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return;

        NetworkRequest networkRequest = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();

        connectivityManager.registerNetworkCallback(networkRequest, new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                // To prevent an infinite restart loop, we ONLY restart automatically 
                // if the error screen is currently visible (i.e., we are stuck offline).
                if (isErrorShown) {
                    runOnUiThread(() -> {
                        Toast.makeText(MainActivity.this, "Connection restored. Restarting Gushu...", Toast.LENGTH_SHORT).show();
                    });
                    
                    handler.postDelayed(() -> {
                        if (isNetworkAvailable()) {
                            restartApp();
                        }
                    }, 1500); 
                }
            }
        });
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return false;
        
        Network network = connectivityManager.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }
}
