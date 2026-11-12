package com.beaustudio.maxbar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Reads the phone's motion sensors and streams the bar's vertical acceleration to Max on the laptop.
 * Runs as a foreground service (with a notification) so it keeps sending while other apps are used or the screen is off.
 *
 * What is sent matches the Max web page for the phone: batches of [seconds, vertical acceleration in m/s², up positive,
 * gravity removed], ten times a second, as a Supabase Realtime broadcast (event "s") on the channel "imubar:<code>".
 */
public class BarService extends Service implements SensorEventListener {
    static final String KEY = "sb_publishable_5koVBvlr6eQSKk2QuSbWmg_wpCFJ6gQ";
    static final String WS_URL = "wss://bxswcxqkwkswffthqgls.supabase.co/realtime/v1/websocket?apikey=" + KEY + "&vsn=1.0.0";
    static final String EXTRA_CODE = "code";
    static final String ACTION_STOP = "com.beaustudio.maxbar.STOP";
    static final String PREFS = "maxbar";
    private static final String CHANNEL = "bar";
    private static final long IDLE_STOP_MS = 45L * 60L * 1000L;

    // Status, read by the screen.
    static volatile boolean running = false;
    static volatile boolean linked = false;
    static volatile int hz = 0;
    static volatile long sent = 0;
    static volatile float lastA = 0f;
    static volatile String note = "";

    private SensorManager sensors;
    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock wake;
    private OkHttpClient http;
    private WebSocket socket;
    private volatile boolean joined = false;
    private String topic = "";
    private int ref = 1;

    private final Object lock = new Object();
    private JSONArray batch = new JSONArray();
    private final float[] gravity = new float[3];
    private boolean haveGravity = false;
    private boolean fused = false;
    private int count = 0;
    private long countFrom = 0;
    private long lastMove = 0;
    private long lastBeat = 0;
    private boolean stopping = false;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        goForeground();
        String code = intent != null ? intent.getStringExtra(EXTRA_CODE) : null;
        if (code == null) code = getSharedPreferences(PREFS, MODE_PRIVATE).getString("code", "");
        if (code == null || code.isEmpty()) { stopSelf(); return START_NOT_STICKY; }
        String next = "realtime:imubar:" + code;

        if (running && next.equals(topic)) return START_STICKY;
        if (running) shutdown();

        topic = next;
        stopping = false;
        running = true; linked = false; hz = 0; sent = 0; note = "";
        lastMove = SystemClock.elapsedRealtime();
        countFrom = lastMove;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "maxbar:sensor");
        wake.acquire(4L * 60L * 60L * 1000L);

        thread = new HandlerThread("maxbar");
        thread.start();
        handler = new Handler(thread.getLooper());

        http = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build();
        connect();

        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        Sensor lin = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        Sensor grav = sensors.getDefaultSensor(Sensor.TYPE_GRAVITY);
        int periodUs = 10000;   // 100 readings a second
        if (lin != null && grav != null) {
            fused = true;
            sensors.registerListener(this, grav, periodUs, handler);
            sensors.registerListener(this, lin, periodUs, handler);
        } else {
            fused = false;
            Sensor acc = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (acc == null) { note = "This phone has no motion sensor."; stopSelf(); return START_NOT_STICKY; }
            sensors.registerListener(this, acc, periodUs, handler);
        }
        handler.postDelayed(tick, 100);
        return START_STICKY;
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Bar sensor", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, BarService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Max Bar is running")
                .setContentText("Sending bar motion to Max")
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
        else startForeground(1, n);
    }

    /* ---------- the link to Max ---------- */

    private void connect() {
        if (stopping || http == null) return;
        joined = false; linked = false;
        final String myTopic = topic;
        socket = http.newWebSocket(new Request.Builder().url(WS_URL).build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                try {
                    JSONObject broadcast = new JSONObject().put("ack", false).put("self", false);
                    JSONObject config = new JSONObject().put("broadcast", broadcast)
                            .put("presence", new JSONObject().put("key", ""))
                            .put("postgres_changes", new JSONArray())
                            .put("private", false);
                    JSONObject payload = new JSONObject().put("config", config).put("access_token", KEY);
                    ws.send(new JSONObject().put("topic", myTopic).put("event", "phx_join").put("payload", payload)
                            .put("ref", "1").put("join_ref", "1").toString());
                } catch (Exception e) { note = String.valueOf(e.getMessage()); }
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                try {
                    JSONObject m = new JSONObject(text);
                    String event = m.optString("event");
                    if (!myTopic.equals(m.optString("topic"))) return;
                    if ("phx_reply".equals(event) && "1".equals(m.optString("ref"))) {
                        JSONObject p = m.optJSONObject("payload");
                        boolean ok = p != null && "ok".equals(p.optString("status"));
                        joined = ok; linked = ok;
                        note = ok ? "" : "Max refused the link: " + (p != null ? p.toString() : "no reason given");
                    } else if ("phx_error".equals(event) || "phx_close".equals(event)) {
                        joined = false; linked = false;
                        ws.close(1000, null);
                    }
                } catch (Exception e) { note = String.valueOf(e.getMessage()); }
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) { dropped(ws, null); }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) { dropped(ws, t); }
        });
    }

    private void dropped(WebSocket ws, Throwable t) {
        if (ws != socket) return;
        joined = false; linked = false;
        if (t != null) note = "No connection: " + t.getMessage();
        Handler h = handler;
        if (!stopping && h != null) h.postDelayed(this::connect, 3000);
    }

    /* ---------- sensors ---------- */

    @Override
    public void onSensorChanged(SensorEvent e) {
        int type = e.sensor.getType();
        float lx, ly, lz;
        if (type == Sensor.TYPE_GRAVITY) {
            gravity[0] = e.values[0]; gravity[1] = e.values[1]; gravity[2] = e.values[2];
            haveGravity = true;
            return;
        } else if (type == Sensor.TYPE_LINEAR_ACCELERATION) {
            if (!haveGravity) return;
            lx = e.values[0]; ly = e.values[1]; lz = e.values[2];
        } else {
            // No fused sensors on this phone: take gravity as the slow part of the signal.
            if (!haveGravity) { gravity[0] = e.values[0]; gravity[1] = e.values[1]; gravity[2] = e.values[2]; haveGravity = true; }
            float k = 0.02f;
            gravity[0] += (e.values[0] - gravity[0]) * k;
            gravity[1] += (e.values[1] - gravity[1]) * k;
            gravity[2] += (e.values[2] - gravity[2]) * k;
            lx = e.values[0] - gravity[0]; ly = e.values[1] - gravity[1]; lz = e.values[2] - gravity[2];
        }
        double g = Math.sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2]);
        if (g < 1) return;
        // Acceleration along the vertical, up positive, whichever way the phone is turned.
        double av = (lx * gravity[0] + ly * gravity[1] + lz * gravity[2]) / g;
        double t = e.timestamp / 1e9;
        try {
            JSONArray row = new JSONArray();
            row.put(Math.round(t * 1000.0) / 1000.0);
            row.put(Math.round(av * 1000.0) / 1000.0);
            synchronized (lock) { batch.put(row); }
        } catch (Exception ignored) { }
        count++;
        lastA = (float) av;
        if (Math.abs(av) > 1.5) lastMove = SystemClock.elapsedRealtime();
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    /** Ten times a second: send what has been read, and keep the status and the connection fresh. */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (stopping) return;
            long now = SystemClock.elapsedRealtime();
            JSONArray out;
            synchronized (lock) { out = batch; batch = new JSONArray(); }
            WebSocket ws = socket;
            if (out.length() > 0 && joined && ws != null) {
                try {
                    JSONObject inner = new JSONObject().put("s", out);
                    // How the phone is lying: which way is up, in its own axes.
                    double gm = Math.sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2]);
                    if (haveGravity && gm > 1) inner.put("g", new JSONArray().put(Math.round(gravity[0] / gm * 1000.0) / 1000.0).put(Math.round(gravity[1] / gm * 1000.0) / 1000.0).put(Math.round(gravity[2] / gm * 1000.0) / 1000.0));
                    JSONObject payload = new JSONObject().put("type", "broadcast").put("event", "s").put("payload", inner);
                    ws.send(new JSONObject().put("topic", topic).put("event", "broadcast").put("payload", payload)
                            .put("ref", String.valueOf(++ref)).put("join_ref", "1").toString());
                    sent += out.length();
                } catch (Exception e) { note = String.valueOf(e.getMessage()); }
            }
            if (now - countFrom >= 1000) {
                hz = (int) Math.round(count * 1000.0 / (now - countFrom));
                count = 0; countFrom = now;
            }
            if (ws != null && joined && now - lastBeat >= 25000) {
                lastBeat = now;
                try {
                    ws.send(new JSONObject().put("topic", "phoenix").put("event", "heartbeat").put("payload", new JSONObject())
                            .put("ref", String.valueOf(++ref)).toString());
                } catch (Exception ignored) { }
            }
            if (now - lastMove > IDLE_STOP_MS) { note = "Stopped by itself: the bar had not moved for 45 minutes."; stopSelf(); return; }
            handler.postDelayed(this, 100);
        }
    };

    private void shutdown() {
        stopping = true;
        if (sensors != null) sensors.unregisterListener(this);
        if (handler != null) handler.removeCallbacksAndMessages(null);
        WebSocket ws = socket; socket = null;
        if (ws != null) ws.close(1000, null);
        if (thread != null) thread.quitSafely();
        if (wake != null && wake.isHeld()) wake.release();
        if (http != null) { http.dispatcher().executorService().shutdown(); http = null; }
        handler = null; thread = null; wake = null;
        joined = false; haveGravity = false;
        running = false; linked = false; hz = 0;
    }

    @Override
    public void onDestroy() {
        shutdown();
        super.onDestroy();
    }
}
