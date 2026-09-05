package com.callstack.agentdevice.imehelper;

final class PrivateInputValue {
  static String compare(String expected, CharSequence observed,
      int startOffset, int partialStartOffset, int partialEndOffset) {
    if (observed == null) return "unknown";
    if (startOffset != 0 || partialStartOffset != -1 || partialEndOffset != -1
        || observed.length() > 16_000 || expected.length() > 16_000) return "unknown";
    if (observed.length() > 0 && observed.toString().matches("(?s).*[\\u00b7\\u2022\\u25cf\\u25cb\\u2217*].*"))
      return "unknown";
    return expected.contentEquals(observed) ? "match" : "mismatch";
  }
}
