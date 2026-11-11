package com.beaustudio.maxbar;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Locale;

/** The one screen: the pairing code from Max, Start / Stop, and what is being sent. */
public class MainActivity extends Activity {
    private EditText code;
    private Button button;
    private TextView status, big, detail, noteView;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(20, 22, 26));
        root.setPadding(pad, dp(48), pad, pad);
        root.setFitsSystemWindows(true);

        root.addView(text("MAX", 16, Color.rgb(230, 242, 60), true));
        root.addView(text("Bar sensor", 30, Color.WHITE, true));
        root.addView(space(16));
        root.addView(text("Code from Max on the laptop (Config → Sensors → Phone on the bar):", 15, Color.rgb(170, 175, 185), false));

        code = new EditText(this);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        code.setSingleLine(true);
        code.setTextSize(26);
        code.setTextColor(Color.WHITE);
        code.setTypeface(Typeface.MONOSPACE);
        code.setHint("code");
        code.setHintTextColor(Color.rgb(90, 95, 105));
        code.setText(prefs().getString("code", ""));
        root.addView(code, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(space(12));

        button = new Button(this);
        button.setTextSize(22);
        button.setAllCaps(false);
        button.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { toggle(); }
        });
        root.addView(button, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(72)));
        root.addView(space(20));

        status = text("", 20, Color.WHITE, true);
        root.addView(status);
        big = text("", 44, Color.WHITE, true);
        root.addView(big);
        detail = text("", 15, Color.rgb(170, 175, 185), false);
        root.addView(detail);
        root.addView(space(12));
        noteView = text("", 15, Color.rgb(255, 120, 120), false);
        root.addView(noteView);
        root.addView(space(16));
        root.addView(text("Press Start, then fix the phone to the bar, any way round, so it can't shift. It keeps sending while you use other apps or the screen is off. Stop it here or from the notification.", 14, Color.rgb(130, 135, 145), false));

        setContentView(root);
    }

    private void toggle() {
        if (BarService.running) {
            startService(new Intent(this, BarService.class).setAction(BarService.ACTION_STOP));
            return;
        }
        String c = code.getText().toString().trim().toLowerCase(Locale.US);
        if (c.length() < 4) { noteView.setText("Enter the code shown in Max on the laptop."); return; }
        prefs().edit().putString("code", c).apply();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        BarService.note = "";
        try {
            startForegroundService(new Intent(this, BarService.class).putExtra(BarService.EXTRA_CODE, c));
        } catch (Exception e) {
            noteView.setText("Could not start: " + e.getMessage());
        }
    }

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            boolean on = BarService.running;
            button.setText(on ? "Stop" : "Start");
            code.setEnabled(!on);
            if (on) {
                int hz = BarService.hz;
                status.setText(hz > 0 ? hz + " readings a second" : "no motion readings");
                status.setTextColor(hz > 0 ? Color.rgb(90, 200, 120) : Color.rgb(255, 120, 120));
                big.setText(String.format(Locale.US, "%+.2f m/s²", BarService.lastA));
                detail.setText((BarService.linked ? "Linked to Max" : "Linking…") + " · " + String.format(Locale.US, "%,d", BarService.sent) + " sent");
            } else {
                status.setText("Stopped");
                status.setTextColor(Color.rgb(170, 175, 185));
                big.setText("");
                detail.setText("");
            }
            String n = BarService.note;
            if (on || (n != null && !n.isEmpty())) noteView.setText(n == null ? "" : n);
            ui.postDelayed(this, 500);
        }
    };

    @Override protected void onResume() { super.onResume(); ui.post(refresh); }
    @Override protected void onPause() { super.onPause(); ui.removeCallbacks(refresh); }

    private SharedPreferences prefs() { return getSharedPreferences(BarService.PREFS, MODE_PRIVATE); }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private View space(int h) { View v = new View(this); v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(h))); return v; }
    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.START);
        return t;
    }
}
