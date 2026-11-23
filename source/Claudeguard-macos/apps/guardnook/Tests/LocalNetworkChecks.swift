import Foundation

private final class StubNetwork: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

struct LocalNetworkTests {
    private func verifiedStatus(_ ip: String) -> GuardStatus {
        let object: [String: Any] = ["state": "protected", "enabled": true, "prepared": true,
            "manual": false, "requireTun": true, "tunEnabled": true,
            "policyGroup": "GuardNook-Claude", "pinnedProxy": "GuardNook-Pinned",
            "expectedIP": ip, "last": ["ip": ip],
            "gateway": ["open": true, "clientGatewayPort": 7901, "expiresAt": Date.now.timeIntervalSince1970 * 1000 + 20_000]]
        return try! JSONDecoder().decode(GuardStatus.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func session(_ handler: @escaping (URLRequest) throws -> (Int, String)) -> URLSession {
        StubNetwork.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubNetwork.self]
        return URLSession(configuration: config)
    }

    func testCurrentPathDoesNotPinOrDisableSystemProxies() {
        let session = LocalEnvProbe.currentPathSession()
        defer { session.invalidateAndCancel() }
        expectNil(session.configuration.connectionProxyDictionary)
        expectNil(session.configuration.httpCookieStorage)
        expectNil(session.configuration.urlCredentialStorage)
    }

    func testReportsServiceSpecificExitAndDoesNotRequireFixedIP() async {
        let session = session { request in
            expectEqual(request.url?.host, "claude.ai")
            return request.url?.path == "/cdn-cgi/trace" ? (200, "ip=203.0.113.9\nloc=JP\ncolo=NRT\n") : (200, "login")
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.9")
        let verdict = LocalVerdict.build(env: nil, probes: [probe])
        expectEqual(verdict.headline, "Claude 尚未配置保护")
        let systemOnly = LocalVerdict.build(env: nil, probes: [probe], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectNil(systemOnly.exitProbe)
        var guarded = probe; guarded.viaGuard = true
        let allowed = LocalVerdict.build(env: nil, probes: [guarded], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectEqual(allowed.headline, "Claude 守护网关已放行")
    }

    func testRestrictedHTTPResponseMeansReachableWithRestriction() async {
        let session = session { request in
            request.url?.path == "/cdn-cgi/trace" ? (200, "ip=203.0.113.9\n") : (403, "blocked")
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.9")
        expectEqual(probe.reason, "网页受 Cloudflare 挑战（HTTP 403），网络路径正常")
    }

    func testSystemPathCannotOverrideClosedGateway() {
        let probe = ClaudeProbe(at: Date(), ok: true, ip: "198.51.100.7")
        var status = verifiedStatus("203.0.113.9")
        status.state = "blocked"; status.reason = "tun-required"
        status.requireTun = true; status.tunEnabled = false; status.gateway?.open = false
        let verdict = LocalVerdict.build(env: nil, probes: [probe], status: status, expectedIP: "203.0.113.9")
        expectEqual(verdict.headline, "Claude 守护网关已阻断")
        expectTrue(verdict.level == .bad)
        expectNil(verdict.exitProbe)
        expectEqual(verdict.exitPlaceholder, "未放行")
    }

    func testGuardedMismatchCannotBePassing() {
        let probe = ClaudeProbe(at: Date(), ok: false, ip: "198.51.100.7", viaGuard: true)
        let verdict = LocalVerdict.build(env: nil, probes: [probe], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectEqual(verdict.headline, "Claude 通道出口不符")
        expectTrue(verdict.level == .bad)
        expectEqual(verdict.exitProbe?.ip, "198.51.100.7")
    }

    func testReachabilityCannotConfirmUnavailableOrWrongGateway() {
        let probe = ClaudeProbe(at: Date(), ok: true, ip: "203.0.113.9")
        let missing = LocalVerdict.build(env: nil, probes: [probe], expectedIP: "203.0.113.9")
        expectEqual(missing.headline, "Claude 保护未确认")
        let wrong = LocalVerdict.build(env: nil, probes: [probe], status: verifiedStatus("198.51.100.7"), expectedIP: "203.0.113.9")
        expectEqual(wrong.headline, "Claude 守护网关已阻断")
    }

    func testCodexReportsItsOwnExit() async {
        let session = session { request in
            expectEqual(request.url?.host, "chatgpt.com")
            return request.url?.path == "/cdn-cgi/trace" ? (200, "ip=2001:db8::7\n") : (200, "ChatGPT")
        }
        let probe = await LocalEnvProbe.serviceProbe(host: "chatgpt.com", availabilityPath: "/", session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "2001:db8::7")
    }

    func testInvalidExitCannotBecomeReady() async {
        let session = session { _ in (200, "ip=not-an-ip\n") }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectFalse(probe.ok)
        expectEqual(probe.reason, "响应缺少有效出口 IP")
        expectNil(probe.ip)
    }

    func testFailureDoesNotFallBackToPinnedOrOldExit() async {
        var requests = 0
        let session = session { _ in
            requests += 1
            throw URLError(.timedOut)
        }
        var probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        probe.viaGuard = true
        expectFalse(probe.ok)
        expectEqual(requests, 1)
        let older = ClaudeProbe(at: Date().addingTimeInterval(-20), ok: true, ip: "203.0.113.10", viaGuard: true)
        let verdict = LocalVerdict.build(env: nil, probes: [older, probe], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectNil(verdict.exitProbe)
        expectEqual(verdict.headline, "Claude 通道探测未通过")
    }

    func testProxyFailureIsNotReportedAsTimeout() async {
        let session = session { _ in throw NSError(domain: "kCFErrorDomainCFNetwork", code: 310) }
        let probe = await LocalEnvProbe.serviceProbe(host: "claude.ai", availabilityPath: "/login", session: session)
        expectFalse(probe.ok)
        expectEqual(probe.reason, "kCFErrorDomainCFNetwork 310")
    }

    func testExpiredResultIsUnknown() {
        let old = ClaudeProbe(at: Date().addingTimeInterval(-46), ok: true, ip: "203.0.113.9", viaGuard: true)
        let verdict = LocalVerdict.build(env: nil, probes: [old], status: verifiedStatus("203.0.113.9"), expectedIP: "203.0.113.9")
        expectEqual(verdict.headline, "通道检测已过期")
        expectNil(verdict.exitProbe)
    }

    func testIPv4UsesActualObserverAndFreshFallback() async {
        var hosts: [String] = []
        let session = session { request in
            hosts.append(request.url!.host!)
            return request.url?.host == "2026.ip138.com" ? (503, "unavailable") : (200, "Current IP: 203.0.113.22")
        }
        let probe = await LocalEnvProbe.probeIPv4(session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.22")
        expectEqual(probe.source, "my.ip.cn")
        expectEqual(hosts, ["2026.ip138.com", "my.ip.cn"])
    }

    func testIPv4RejectsInvalidAndAmbiguousResponse() async {
        for body in ["999.1.2.3", "203.0.113.1 and 203.0.113.2", "no IP"] {
            let session = session { _ in (200, body) }
            let probe = await LocalEnvProbe.probeIPv4(session: session)
            expectFalse(probe.ok)
            expectNil(probe.ip)
        }
    }

    func testObserverHTTPFailureCannotBecomeAnExit() async {
        let session = session { _ in (403, "ip=203.0.113.10\n") }
        let probe = await LocalEnvProbe.probeCloudflare(session: session)
        expectFalse(probe.ok)
        expectNil(probe.ip)
        expectEqual(probe.reason, "出口检测 HTTP 403")
    }

    func testCloudflareReportsItsOwnTraceWithoutClaudeRequest() async {
        let session = session { request in
            expectEqual(request.url?.absoluteString, "https://1.1.1.1/cdn-cgi/trace")
            return (200, "ip=203.0.113.33\nloc=US\ncolo=LAX\n")
        }
        let probe = await LocalEnvProbe.probeCloudflare(session: session)
        expectTrue(probe.ok)
        expectEqual(probe.ip, "203.0.113.33")
        expectEqual(probe.colo, "LAX")
    }

    func testObserverFailureDoesNotBorrowPinnedIP() async {
        let session = session { _ in throw URLError(.timedOut) }
        let probe = await LocalEnvProbe.probeIPv4(session: session)
        expectFalse(probe.ok)
        expectNil(probe.ip)
        expectEqual(probe.reason, "请求超时")
    }

    func testComparisonRequiresFreshCompleteObservations() {
        let now = Date()
        let a = NetworkExitProbe(at: now, ok: true, ip: "203.0.113.1", source: "observer")
        var b = a
        let claude = ClaudeProbe(at: now, ok: true, ip: "203.0.113.1")
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .same)
        b.ip = "203.0.113.2"
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .different)
        b.ok = false
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .pending)
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: nil, claude: claude, now: now), .pending)
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: a, claude: claude, now: now.addingTimeInterval(46)), .expired)
        b = a; b.at = now.addingTimeInterval(-31)
        expectEqual(ExitComparison.evaluate(ipv4: a, cloudflare: b, claude: claude, now: now), .expired)
        expectNil(a.currentIP(now: now.addingTimeInterval(46)))
    }

    private var guardedSettings: GuardSettings {
        try! JSONDecoder().decode(GuardSettings.self, from: Data(#"{"requireTun":true,"expectedIP":"203.0.113.9","policyGroup":"GuardNook-Claude","pinnedProxy":"GuardNook-Pinned","clientPort":7901}"#.utf8))
    }

    func testClosedGateSkipsInternetProbe() async {
        var gate = verifiedStatus("203.0.113.9"); gate.gateway?.open = false
        var calls = 0
        let probe = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { gate }, fetchTrace: { _ in
            calls += 1; return GuardedTraceResponse(code: 200, body: "ip=198.51.100.7\n")
        })
        expectEqual(calls, 0); expectFalse(probe.ok); expectNil(probe.ip)
        expectTrue(probe.reason?.hasPrefix("未放行") == true)
    }

    func testGuardedProbeUsesClientGatewayAndActualResponse() async {
        var ports: [Int] = []
        let probe = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { verifiedStatus("203.0.113.9") }, fetchTrace: { port in
            ports.append(port); return GuardedTraceResponse(code: 200, body: "ip=203.0.113.9\nloc=US\ncolo=LAX\n")
        })
        expectEqual(ports, [7901]); expectTrue(probe.ok); expectTrue(probe.viaGuard)
        expectEqual(probe.ip, "203.0.113.9"); expectEqual(probe.viaProxy, "127.0.0.1:7901")
        expectEqual(probe.colo, "LAX")
    }

    func testShareProbeRequiresMihomoRouteEvidence() async {
        var portable = verifiedStatus("203.0.113.9")
        portable.gateway?.clientGatewayPort = nil
        let scoped = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { portable },
            fetchTrace: { _ in fatalError("Portable mode must not use an unverified trace") },
            fetchClientExit: { GuardedClientExit(state: "verified", clientPort: 7901, ip: "203.0.113.9") })
        expectTrue(scoped.ok)
        expectEqual(LocalVerdict.build(env: nil, probes: [scoped], status: portable, expectedIP: "203.0.113.9", clientPort: 7901).exitProbe?.ip, "203.0.113.9")
        let unproven = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { portable },
            fetchClientExit: { GuardedClientExit(state: "needs-review", clientPort: 7901, ip: "203.0.113.9") })
        expectFalse(unproven.ok); expectNil(unproven.ip)
    }

    func testGateClosingDuringProbeDropsResponse() async {
        var calls = 0
        let probe = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: {
            calls += 1; var status = verifiedStatus("203.0.113.9")
            if calls == 2 { status.gateway?.open = false }
            return status
        }, fetchTrace: { _ in GuardedTraceResponse(code: 200, body: "ip=203.0.113.9\n") })
        expectEqual(calls, 2); expectFalse(probe.ok); expectNil(probe.ip)
    }

    func testGuardIdentityAndAdmissionMustMatch() async {
        for variant in 0..<9 {
            var calls = 0; var gate = verifiedStatus("203.0.113.9")
            switch variant {
                case 0: gate.policyGroup = "other"
                case 1: gate.pinnedProxy = "other"
                case 2: gate.gateway?.clientGatewayPort = 7897
                case 3: gate.manual = true
                case 4: gate.gateway?.expiresAt = 0
                case 5: gate.tunEnabled = false
                case 6: gate.enabled = false
                case 7: gate.expectedIP = "198.51.100.7"
                default: gate.requireTun = false
            }
            let probe = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { gate }, fetchTrace: { _ in
                calls += 1; return GuardedTraceResponse(code: 200, body: "ip=203.0.113.9\n")
            })
            expectEqual(calls, 0); expectFalse(probe.ok); expectNil(probe.ip)
        }
    }

    func testTraceFailureNeverUsesSystemOrConfiguredIP() async {
        var calls = 0
        let probe = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { verifiedStatus("203.0.113.9") }, fetchTrace: { _ in
            calls += 1; throw URLError(.cannotConnectToHost)
        })
        expectEqual(calls, 1); expectFalse(probe.ok); expectNil(probe.ip)
    }

    func testInvalidGuardedTraceDoesNotPass() async {
        for response in [GuardedTraceResponse(code: 403, body: "ip=203.0.113.9\n"),
                         GuardedTraceResponse(code: 200, body: "ip=not-an-ip\n"),
                         GuardedTraceResponse(code: 200, body: String(repeating: "x", count: 4097)),
                         GuardedTraceResponse(code: 200, body: "ip=198.51.100.7\n")] {
            let probe = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { verifiedStatus("203.0.113.9") }, fetchTrace: { _ in response })
            expectFalse(probe.ok)
            expectFalse(probe.ip == "203.0.113.9")
        }
    }

    func testMissingStatusOrConfigurationNeverProbesInternet() async {
        var calls = 0
        let missing = await LocalEnvProbe.probeClaude(settings: nil, fetchStatus: { throw URLError(.cannotConnectToHost) }, fetchTrace: { _ in
            calls += 1; throw URLError(.cannotConnectToHost)
        })
        let unavailable = await LocalEnvProbe.probeClaude(settings: guardedSettings, fetchStatus: { throw URLError(.cannotConnectToHost) }, fetchTrace: { _ in
            calls += 1; throw URLError(.cannotConnectToHost)
        })
        expectEqual(calls, 0); expectNil(missing.ip); expectNil(unavailable.ip)
    }

    func testLatestSystemSampleOrOldEndpointCannotBeGuardedExit() {
        let guarded = ClaudeProbe(at: Date(), ok: true, ip: "203.0.113.9", viaProxy: "127.0.0.1:7901", viaGuard: true)
        let system = ClaudeProbe(at: Date(), ok: true, ip: "198.51.100.7")
        let gate = verifiedStatus("203.0.113.9")
        expectNil(LocalVerdict.build(env: nil, probes: [guarded, system], status: gate, expectedIP: "203.0.113.9").exitProbe)
        expectNil(LocalVerdict.build(env: nil, probes: [guarded], status: gate, expectedIP: "203.0.113.9", clientPort: 7902).exitProbe)
    }
}

private func expectTrue(_ value: Bool) { precondition(value, "Expected true") }
private func expectFalse(_ value: Bool) { precondition(!value, "Expected false") }
private func expectNil<T>(_ value: T?) { precondition(value == nil, "Expected nil") }
private func expectEqual<T: Equatable>(_ actual: T, _ expected: T) { precondition(actual == expected, "Expected \(expected), got \(actual)") }

@main struct NetworkChecks {
    static func main() async {
        let checks = LocalNetworkTests()
        checks.testCurrentPathDoesNotPinOrDisableSystemProxies()
        await checks.testReportsServiceSpecificExitAndDoesNotRequireFixedIP()
        await checks.testRestrictedHTTPResponseMeansReachableWithRestriction()
        checks.testSystemPathCannotOverrideClosedGateway()
        checks.testGuardedMismatchCannotBePassing()
        checks.testReachabilityCannotConfirmUnavailableOrWrongGateway()
        await checks.testCodexReportsItsOwnExit()
        await checks.testInvalidExitCannotBecomeReady()
        await checks.testFailureDoesNotFallBackToPinnedOrOldExit()
        await checks.testProxyFailureIsNotReportedAsTimeout()
        checks.testExpiredResultIsUnknown()
        await checks.testIPv4UsesActualObserverAndFreshFallback()
        await checks.testIPv4RejectsInvalidAndAmbiguousResponse()
        await checks.testObserverHTTPFailureCannotBecomeAnExit()
        await checks.testCloudflareReportsItsOwnTraceWithoutClaudeRequest()
        await checks.testObserverFailureDoesNotBorrowPinnedIP()
        checks.testComparisonRequiresFreshCompleteObservations()
        await checks.testClosedGateSkipsInternetProbe()
        await checks.testGuardedProbeUsesClientGatewayAndActualResponse()
        await checks.testShareProbeRequiresMihomoRouteEvidence()
        await checks.testGateClosingDuringProbeDropsResponse()
        await checks.testGuardIdentityAndAdmissionMustMatch()
        await checks.testTraceFailureNeverUsesSystemOrConfiguredIP()
        await checks.testInvalidGuardedTraceDoesNotPass()
        await checks.testMissingStatusOrConfigurationNeverProbesInternet()
        checks.testLatestSystemSampleOrOldEndpointCannotBeGuardedExit()
        print("PASS: 26 local network regression checks")
        if CommandLine.arguments.contains("--guard-live") {
            guard let settings = GuardSettings.current else { fatalError("Missing live settings") }
            let status = try! await GuardClient.fetchStatus()
            let probe = await LocalEnvProbe.probeClaude()
            print("Live client gateway: ok=\(probe.ok), IP=\(probe.ip ?? "none"), reason=\(probe.reason ?? "none")")
            if !status.verifiedNow {
                expectFalse(probe.ok); expectNil(probe.ip)
                // Force the transport path against the REAL closed gateway.
                // This fixture changes no service state or production config.
                var fixture = status
                fixture.state = "protected"; fixture.enabled = true; fixture.manual = false; fixture.prepared = true
                fixture.tunEnabled = true; fixture.gateway?.open = true
                fixture.last?.ip = settings.expectedIP
                fixture.gateway?.expiresAt = Date.now.timeIntervalSince1970 * 1000 + 30_000
                let transport = await LocalEnvProbe.probeClaude(settings: settings, fetchStatus: { fixture })
                expectFalse(transport.ok); expectNil(transport.ip)
                print("PASS: real closed gateway rejects transport; no system-path fallback")
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            let profile = LocalEnvProbe.guardedTraceArguments(port: settings.clientPort!)[1]
            process.arguments = ["-p", profile, "/usr/bin/python3", "-c", """
            import socket, errno
            for family, host, port in [(socket.AF_INET, '1.1.1.1', 443), (socket.AF_INET6, '2606:4700:4700::1111', 443), (socket.AF_INET, '127.0.0.1', 7897)]:
                with socket.socket(family, socket.SOCK_STREAM) as sock:
                    sock.settimeout(2)
                    try:
                        sock.connect((host, port))
                    except OSError as error:
                        assert error.errno == errno.EPERM, repr(error)
                    else:
                        raise AssertionError('Sandbox permitted an alternative path')
            print('PASS: OS sandbox rejects public IPv4, IPv6 and alternative local proxy')
            """]
            try! process.run(); process.waitUntilExit()
            expectEqual(process.terminationStatus, 0)
        }
        if CommandLine.arguments.contains("--live") {
            async let claude = LocalEnvProbe.probeClaude()
            async let codex = LocalEnvProbe.probeCodex()
            async let ipv4 = LocalEnvProbe.probeIPv4()
            async let cloudflare = LocalEnvProbe.probeCloudflare()
            let (a, b, c, d) = await (claude, codex, ipv4, cloudflare)
            print("Claude guarded path: ok=\(a.ok), IP=\(a.ip ?? "unknown"), reason=\(a.reason ?? "none")")
            print("Codex current path: ok=\(b.ok), IP=\(b.ip ?? "unknown"), reason=\(b.reason ?? "none")")
            print("IPv4 current path: ok=\(c.ok), IP=\(c.ip ?? "unknown"), source=\(c.source), reason=\(c.reason ?? "none")")
            print("Cloudflare current path: ok=\(d.ok), IP=\(d.ip ?? "unknown"), reason=\(d.reason ?? "none")")
        }
    }
}
