import XCTest
import Network

#if AGENT_DEVICE_RUNNER_UNIT_TESTS
extension RunnerTests {
  private static let transportToken = String(repeating: "k", count: 32)

  /// Serves through the production listener factory with a fixed token.
  private func startTransportListener() throws -> NWListener {
    listenerToken = RunnerListenerToken(Self.transportToken)
    let listener = try Self.makeRunnerListener(port: .any)
    let ready = expectation(description: "HTTP listener ready")
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.fulfill() }
    }
    listener.newConnectionHandler = { connection in
      self.handle(connection: connection)
    }
    listener.start(queue: transportQueue)
    wait(for: [ready], timeout: 2)
    return listener
  }

  func testUptimeHttpRemainsResponsiveWhileCommandQueueIsOccupied() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 3
    configuration.timeoutIntervalForResource = 3
    let client = URLSession(configuration: configuration)
    defer { client.invalidateAndCancel() }

    let occupied = expectation(description: "command queue occupied")
    let drained = DispatchSemaphore(value: 0)
    let releaseWork = DispatchSemaphore(value: 0)
    commandExecutionQueue.async {
      occupied.fulfill()
      releaseWork.wait()
      drained.signal()
    }
    defer {
      releaseWork.signal()
      XCTAssertEqual(drained.wait(timeout: .now() + 2), .success)
    }
    wait(for: [occupied], timeout: 2)

    let started = ProcessInfo.processInfo.systemUptime
    let uptime = try transportHttpResponse(
      client: client,
      port: port,
      payload: #"{"command":"uptime","commandId":"occupied-preflight"}"#
    )
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    XCTAssertTrue(uptime.ok)
    XCTAssertNotNil(uptime.data?.currentUptimeMs)
    XCTAssertLessThan(elapsed, 1)
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "occupied-preflight").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue
    )

    let queued = transportHttpRequest(
      client: client,
      port: port,
      payload: #"{"command":"appState","commandId":"after-preflight"}"#
    )
    let acceptedDeadline = Date().addingTimeInterval(1)
    var state: String?
    repeat {
      state = try transportHttpResponse(
        client: client,
        port: port,
        payload: #"{"command":"status","statusCommandId":"after-preflight"}"#
      ).data?.lifecycleState
    } while state == RunnerCommandLifecycleState.notAccepted.rawValue && Date() < acceptedDeadline
    XCTAssertEqual(state, RunnerCommandLifecycleState.accepted.rawValue)
    releaseWork.signal()
    wait(for: [queued.finished], timeout: 2)
    let response = try queued.response()
    XCTAssertEqual(response.error?.message, "appState requires appBundleId")
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "after-preflight").lifecycleState,
      RunnerCommandLifecycleState.failed.rawValue
    )
    NSLog("AGENT_DEVICE_RUNNER_OCCUPIED_UPTIME_MS=%.1f", elapsed * 1000)
  }

  private final class TransportHttpReply {
    let finished = XCTestExpectation(description: "HTTP response received")
    var data: Data?
    var status: Int?
    var authHeader: String?
    var error: Error?

    func response() throws -> Response {
      if let error { throw error }
      return try JSONDecoder().decode(Response.self, from: XCTUnwrap(data))
    }
  }

  private func transportHttpRequest(
    client: URLSession,
    port: NWEndpoint.Port,
    payload: String,
    token: String? = RunnerTests.transportToken
  ) -> TransportHttpReply {
    let reply = TransportHttpReply()
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port.rawValue)/command")!)
    request.httpMethod = "POST"
    request.httpBody = Data(payload.utf8)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token {
      request.setValue(token, forHTTPHeaderField: RunnerListenerToken.requestHeaderName)
    }
    client.dataTask(with: request) { data, response, error in
      reply.status = (response as? HTTPURLResponse)?.statusCode
      reply.authHeader = (response as? HTTPURLResponse)?.value(
        forHTTPHeaderField: Self.authEnforcedResponseHeader
      )
      reply.data = data
      reply.error = error
      reply.finished.fulfill()
    }.resume()
    return reply
  }

  private func transportHttpResponse(
    client: URLSession,
    port: NWEndpoint.Port,
    payload: String,
    token: String? = RunnerTests.transportToken
  ) throws -> Response {
    let reply = transportHttpRequest(client: client, port: port, payload: payload, token: token)
    wait(for: [reply.finished], timeout: 2)
    return try reply.response()
  }

  func testRunnerListenerBindsLoopbackOffDevice() throws {
    let listener = try Self.makeRunnerListener(port: .any)
    #if targetEnvironment(simulator) || os(macOS)
      guard case .hostPort(let host, _) = try XCTUnwrap(listener.parameters.requiredLocalEndpoint),
        case .ipv4(let address) = host
      else {
        return XCTFail("listener must require a loopback local endpoint")
      }
      XCTAssertTrue(address.isLoopback)
    #endif
  }

  func testListenerRefusesRequestsWithoutTheTokenBeforeDecoding() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }

    for token in [nil, "wrong"] as [String?] {
      let reply = transportHttpRequest(
        client: client,
        port: port,
        payload: #"{"command":"appState","commandId":"without-token"}"#,
        token: token
      )
      wait(for: [reply.finished], timeout: 2)
      XCTAssertEqual(reply.status, 401)
      XCTAssertEqual(reply.authHeader, "required")
      XCTAssertEqual(try reply.response().error?.code, "UNAUTHORIZED")
    }
    XCTAssertEqual(
      commandJournal.status(normalizedCommandId: "without-token").lifecycleState,
      RunnerCommandLifecycleState.notAccepted.rawValue
    )
  }

  func testListenerKeepsServingAfterRefusingABadlyFramedRequest() throws {
    let listener = try startTransportListener()
    defer { listener.cancel() }
    let port = try XCTUnwrap(listener.port)
    let token = "\(RunnerListenerToken.requestHeaderName): \(Self.transportToken)"
    let tooLarge = RunnerHttpRequestFraming.maxBodyBytes + 1
    let refusals = [
      ("POST /command HTTP/1.1\r\n\(token)\r\nContent-Length: -5\r\n\r\n{}", 400),
      ("POST /command HTTP/1.1\r\n\(token)\r\nContent-Length: \(tooLarge)\r\n\r\n", 413),
      ("POST /command HTTP/1.1\r\nContent-Length: \(tooLarge)\r\n\r\n", 401),
    ]
    for (request, status) in refusals {
      XCTAssertEqual(try rawTransportStatus(port: port, request: request), status, request)
    }
    let client = URLSession(configuration: .ephemeral)
    defer { client.invalidateAndCancel() }
    let uptime = try transportHttpResponse(
      client: client,
      port: port,
      payload: #"{"command":"uptime"}"#
    )
    XCTAssertTrue(uptime.ok)
  }

  /// Sends raw bytes and returns the status the runner answered with.
  private func rawTransportStatus(port: NWEndpoint.Port, request: String) throws -> Int? {
    let connection = NWConnection(host: .ipv4(.loopback), port: port, using: .tcp)
    let answered = expectation(description: "raw response")
    final class Box: @unchecked Sendable { var data = Data() }
    let box = Box()
    connection.start(queue: .global())
    connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
    func read() {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, error in
        if let data { box.data.append(data) }
        if done || error != nil { answered.fulfill() } else { read() }
      }
    }
    read()
    wait(for: [answered], timeout: 3)
    connection.cancel()
    let statusLine = String(decoding: box.data, as: UTF8.self).split(separator: "\r\n").first ?? ""
    let parts = statusLine.split(separator: " ")
    return parts.count > 1 ? Int(parts[1]) : nil
  }

  func testDuplicateCommandIdCoalescesOntoInFlightExecution() throws {
    let command = try JSONDecoder().decode(
      Command.self,
      from: Data(#"{"command":"snapshot","commandId":"snapshot-coalesce"}"#.utf8)
    )
    final class Delivered {
      var primaryData: Data?
      var waiterData: Data?
    }
    let delivered = Delivered()
    defer {
      inFlightCommandIds.removeAll()
      inFlightCommandWaiters.removeAll()
    }

    XCTAssertFalse(
      attachToInFlightCommandIfNeeded(command: command) { result in
        delivered.primaryData = result.data
      }
    )
    XCTAssertTrue(
      attachToInFlightCommandIfNeeded(command: command) { result in
        delivered.waiterData = result.data
      }
    )

    let result = Data("single-result".utf8)
    deliverCommandResult(
      command: command,
      result: (result, false)
    ) { result in
      delivered.primaryData = result.data
    }

    XCTAssertEqual(delivered.primaryData, result)
    XCTAssertEqual(delivered.waiterData, result)
    XCTAssertFalse(inFlightCommandIds.contains("snapshot-coalesce"))
    XCTAssertNil(inFlightCommandWaiters["snapshot-coalesce"])
  }

  /// Routes `command` through the transport's inline and queued paths. The calling test's main
  /// thread serves the command's main-thread work while it waits.
  func execute(command: Command) throws -> Response {
    dispatchPrecondition(condition: .onQueue(.main))
    if let response = inlineResponse(for: command) {
      return response
    }
    final class ResultBox {
      var result: Result<Response, Error>?
    }
    let box = ResultBox()
    let executed = XCTestExpectation(description: "\(command.command.rawValue) executed off main")
    enqueueAccepted(command: command) { result in
      box.result = result
      executed.fulfill()
    }
    guard XCTWaiter.wait(for: [executed], timeout: Self.mainThreadExecutionTimeout + 5) == .completed,
      let result = box.result
    else {
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.commandReturnedNoResponse,
        userInfo: [NSLocalizedDescriptionKey: "command did not finish on the command queue"]
      )
    }
    return try result.get()
  }
}
#endif
