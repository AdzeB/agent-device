package com.callstack.agentdevice.imehelper;

import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.ExtractedText;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;
import java.util.UUID;
import org.json.JSONObject;

final class PrivateInputComparison {
  private final String instance = UUID.randomUUID().toString();
  private long generation = 0;
  private final java.util.concurrent.atomic.AtomicBoolean extracting =
      new java.util.concurrent.atomic.AtomicBoolean(false);

  void invalidate() { generation++; }

  JSONObject handle(JSONObject request, InputConnection connection, EditorInfo editor) {
    try {
      if (request == null) return unknown("request_unavailable");
      if (!"android-private-input-v1".equals(request.optString("protocol")))
        return unknown("protocol_mismatch");
      if (connection == null || editor == null || editor.packageName == null)
        return unknown("connection_unavailable");
      if (!editor.packageName.equals(request.optString("appId")))
        return unknown("app_changed");
      String token = instance + ":" + generation;
      if ("acquire".equals(request.optString("operation"))) {
        return new JSONObject().put("status", "unknown").put("reason", "scope_acquired")
            .put("connectionToken", token).put("appId", editor.packageName)
            .put("fieldId", editor.fieldId);
      }
      if (!"compare".equals(request.optString("operation"))) return unknown("invalid_operation");
      if (!token.equals(request.optString("connectionToken"))) return unknown("connection_changed");
      Object expected = request.opt("expectedValue");
      if (!(expected instanceof String) || ((String) expected).length() > 16_000)
        return unknown("invalid_expected_value");
      ExtractedTextRequest extraction = new ExtractedTextRequest();
      extraction.hintMaxChars = 16_001;
      extraction.hintMaxLines = 16_001;
      ExtractedText actual = extract(connection, extraction);
      if (actual == null || actual.text == null) return unknown("extraction_unavailable");
      String comparison = PrivateInputValue.compare((String) expected, actual.text,
          actual.startOffset, actual.partialStartOffset, actual.partialEndOffset);
      if ("unknown".equals(comparison)) return unknown("incomplete_or_masked_extraction");
      if (!token.equals(instance + ":" + generation)) return unknown("connection_changed");
      return new JSONObject().put("status", comparison).put("connectionToken", token)
          .put("appId", editor.packageName).put("fieldId", editor.fieldId)
          .put("source", "android-ime-extracted-text");
    } catch (Throwable ignored) { return unknown("comparison_unavailable"); }
  }

  private ExtractedText extract(InputConnection connection, ExtractedTextRequest request) {
    if (!extracting.compareAndSet(false, true)) return null;
    java.util.concurrent.FutureTask<ExtractedText> task = new java.util.concurrent.FutureTask<>(
        () -> connection.getExtractedText(request, 0));
    Thread worker = new Thread(() -> {
      try { task.run(); }
      finally { extracting.set(false); }
    }, "private-input-extraction");
    worker.setDaemon(true);
    worker.start();
    try { return task.get(1_500, java.util.concurrent.TimeUnit.MILLISECONDS); }
    catch (Exception ignored) { task.cancel(true); return null; }
  }

  static JSONObject unknown(String reason) {
    JSONObject result = new JSONObject();
    try { result.put("status", "unknown").put("reason", reason); }
    catch (Exception ignored) { }
    return result;
  }
}
