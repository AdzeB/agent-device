import XCTest

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let listenerToken = String(repeating: "t", count: 32)

  func testListenerTokenRequiresAnExactMatch() {
    let token = Self.listenerToken
    let expected = RunnerListenerToken(token)!
    XCTAssertTrue(expected.matches(token))
    XCTAssertFalse(expected.matches(""))
    XCTAssertFalse(expected.matches(String(token.dropLast())))
    XCTAssertFalse(expected.matches(token + "t"))
    XCTAssertFalse(expected.matches(token + String(repeating: "t", count: 256)))
    XCTAssertFalse(expected.matches(String(token.dropLast()) + "u"))
  }
}
#endif
