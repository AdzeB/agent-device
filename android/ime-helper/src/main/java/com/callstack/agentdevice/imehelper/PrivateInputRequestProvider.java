package com.callstack.agentdevice.imehelper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

public final class PrivateInputRequestProvider extends ContentProvider {
  private static final int MAX_BYTES = 65_536;
  private static final Map<String, Request> requests = new HashMap<>();
  private static final java.util.concurrent.Semaphore pending =
      new java.util.concurrent.Semaphore(8);

  private static final class Request {
    final JSONObject value;
    final long expires;
    Request(JSONObject value) {
      this.value = value;
      this.expires = SystemClock.elapsedRealtime() + 5_000;
    }
  }

  static synchronized JSONObject take(String id) {
    long deadline = SystemClock.elapsedRealtime() + 300;
    while (!requests.containsKey(id) && SystemClock.elapsedRealtime() < deadline) {
      try { PrivateInputRequestProvider.class.wait(20); }
      catch (InterruptedException ignored) { return null; }
    }
    Request request = requests.remove(id);
    return request != null && request.expires >= SystemClock.elapsedRealtime()
        ? request.value : null;
  }

  private static synchronized void put(String id, JSONObject value) {
    requests.entrySet().removeIf(entry -> entry.getValue().expires < SystemClock.elapsedRealtime());
    if (requests.size() < 8) {
      Request request = new Request(value);
      requests.put(id, request);
      new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
        synchronized (PrivateInputRequestProvider.class) {
          if (requests.get(id) == request) requests.remove(id);
        }
      }, 5_000);
    }
    PrivateInputRequestProvider.class.notifyAll();
  }

  @Override public boolean onCreate() { return true; }

  @Override public ParcelFileDescriptor openFile(Uri uri, String mode)
      throws java.io.FileNotFoundException {
    String id = uri.getLastPathSegment();
    if (!"w".equals(mode) || id == null || !id.matches("[a-f0-9]{32}"))
      throw new java.io.FileNotFoundException("Invalid private request");
    if (!pending.tryAcquire()) throw new java.io.FileNotFoundException("Private request busy");
    try {
      ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
      new Thread(() -> {
        try (InputStream stream = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])) {
          ByteArrayOutputStream bytes = new ByteArrayOutputStream();
          byte[] buffer = new byte[4096];
          int count;
          while ((count = stream.read(buffer)) != -1) {
            if (bytes.size() + count > MAX_BYTES) return;
            bytes.write(buffer, 0, count);
          }
          put(id, new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8)));
        } catch (Exception ignored) { }
        finally { pending.release(); }
      }, "private-input-request").start();
      new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
        try { pipe[0].close(); } catch (Exception ignored) { }
      }, 2_000);
      return pipe[1];
    } catch (Exception ignored) {
      pending.release();
      throw new java.io.FileNotFoundException("Private request unavailable");
    }
  }

  @Override public String getType(Uri uri) { return "application/json"; }
  @Override public Cursor query(Uri uri, String[] projection, String selection,
      String[] selectionArgs, String sortOrder) { return null; }
  @Override public Uri insert(Uri uri, ContentValues values) { return null; }
  @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
  @Override public int update(Uri uri, ContentValues values, String selection,
      String[] selectionArgs) { return 0; }
}
