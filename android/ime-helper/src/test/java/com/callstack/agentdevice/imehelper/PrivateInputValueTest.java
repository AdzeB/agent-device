package com.callstack.agentdevice.imehelper;

public final class PrivateInputValueTest {
  public static void main(String[] args) {
    expect("match", "1947", "1947", 0, -1, -1);
    expect("mismatch", "1947", "7491", 0, -1, -1);
    expect("match", "", "", 0, -1, -1);
    expect("match", "你好🧪", "你好🧪", 0, -1, -1);
    expect("unknown", "1947", "••••", 0, -1, -1);
    expect("unknown", "****", "****", 0, -1, -1);
    expect("unknown", "1947", "•••7", 0, -1, -1);
    expect("unknown", "1947", "···7", 0, -1, -1);
    expect("unknown", "1947", "•·•7", 0, -1, -1);
    expect("unknown", "1947", "1947", 1, -1, -1);
    expect("unknown", "1947", "1947", 0, 0, 4);
    expect("unknown", "1947", null, 0, -1, -1);
    expect("unknown", "x".repeat(16_001), "x".repeat(16_001), 0, -1, -1);
    System.out.println("PrivateInputValueTest: 13 passed");
  }

  private static void expect(String result, String expected, CharSequence observed,
      int start, int partialStart, int partialEnd) {
    if (!result.equals(PrivateInputValue.compare(expected, observed, start, partialStart, partialEnd)))
      throw new AssertionError("Private comparison classification failed");
  }
}
