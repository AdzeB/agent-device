import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let environmentToken = String(repeating: "t", count: 32)

  func testListenerConfigurationRequiresAPortAndAToken() {
    let port = ["AGENT_DEVICE_RUNNER_PORT": "8100"]
    let token = ["AGENT_DEVICE_RUNNER_TOKEN": Self.environmentToken]
    let configured = RunnerListenerConfiguration.fromEnvironment(port.merging(token) { $1 })
    XCTAssertEqual(configured?.port.rawValue, 8100)
    XCTAssertTrue(configured?.token.matches(Self.environmentToken) ?? false)

    XCTAssertNil(RunnerListenerConfiguration.fromEnvironment(port))
    XCTAssertNil(RunnerListenerConfiguration.fromEnvironment(token))
    for badPort in ["0", "", "65536", "-1", "80a"] {
      XCTAssertNil(
        RunnerListenerConfiguration.fromEnvironment(
          ["AGENT_DEVICE_RUNNER_PORT": badPort].merging(token) { $1 }
        ),
        badPort
      )
    }
    for badToken in ["", String(repeating: "t", count: 31)] {
      XCTAssertNil(
        RunnerListenerConfiguration.fromEnvironment(
          port.merging(["AGENT_DEVICE_RUNNER_TOKEN": badToken]) { $1 }
        ),
        "\(badToken.count)-byte token"
      )
    }
  }
}
#endif
