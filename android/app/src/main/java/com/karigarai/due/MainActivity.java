package com.karigarai.due;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * Turns a "Share > Due" PDF (ACTION_SEND with EXTRA_STREAM) into a VIEW intent carrying the file URI, so
 * Capacitor's App plugin reports it to the web layer as an appUrlOpen event, the same as "Open with Due".
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        normalise(getIntent());
        super.onCreate(savedInstanceState);
        // App-switcher privacy: the recent-apps thumbnail never shows bills, balances or amounts.
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
    }

    @Override
    public void onPause() {
        // Before Android 13 there is no per-app switch: hide the window content while Due is in the background.
        if (Build.VERSION.SDK_INT < 33) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (Build.VERSION.SDK_INT < 33) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        normalise(intent);
        super.onNewIntent(intent);
    }

    @SuppressWarnings("deprecation")
    private static void normalise(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        if (!"application/pdf".equals(intent.getType())) return;
        Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream == null) return;
        intent.setAction(Intent.ACTION_VIEW);
        intent.setDataAndType(stream, "application/pdf");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
}
