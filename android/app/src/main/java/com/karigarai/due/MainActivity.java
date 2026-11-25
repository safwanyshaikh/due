package com.karigarai.due;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
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
