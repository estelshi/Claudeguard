import Foundation

// MARK: - Verdict

/// Only fresh measurements through the admitted client gateway can be an exit.
struct LocalVerdict {
    enum Level {
        case good
        case caution
        case bad
        case unknown
    }

    var level: Level
    var headline: String
    var reason: String
    var lastProbe: ClaudeProbe?
    var exitProbe: ClaudeProbe?
    var exitPlaceholder: String = "未取得"

    static func build(env: LocalEnvState?, probes: [ClaudeProbe], status: GuardStatus? = nil, expectedIP: String? = nil, clientPort: Int? = nil) -> LocalVerdict {
        let last = probes.last.flatMap { $0.viaGuard ? $0 : nil }
        // Never present an older successful sample as the current exit after a failure.
        let exit = last.flatMap { Date.now.timeIntervalSince($0.at) < 45 && $0.ip != nil ? $0 : nil }
        guard let expectedIP, !expectedIP.isEmpty else {
            return LocalVerdict(level: .unknown, headline: "Claude 尚未配置保护", reason: "先设定唯一允许的出口 IP，再通过守护通道实测。", lastProbe: last, exitProbe: nil, exitPlaceholder: "未配置")
        }
        guard let status else {
            return LocalVerdict(level: .bad, headline: "Claude 保护未确认", reason: "无法读取守护状态，暂停通道探测。目标出口 \(expectedIP)。", lastProbe: last, exitProbe: nil, exitPlaceholder: "未确认")
        }
        guard status.expectedIP == expectedIP, status.verifiedNow else {
            return LocalVerdict(level: status.enabled == true ? .bad : .caution, headline: status.enabled == true ? "Claude 守护网关已阻断" : "Claude 尚未启用保护", reason: "目标出口 \(expectedIP)。\(status.reasonText ?? "尚未确认守护放行。") Claude 通道独立阻断，普通网络继续按 Clash 或系统路由运行。", lastProbe: last, exitProbe: nil, exitPlaceholder: "未放行")
        }
        if let clientPort, let dedicatedPort = status.gateway?.clientGatewayPort, dedicatedPort != clientPort {
            return LocalVerdict(level: .bad, headline: "Claude 守护入口未确认", reason: "当前本机入口与配置不一致，未使用系统网络兜底。",
                                lastProbe: nil, exitProbe: nil, exitPlaceholder: "未确认")
        }
        if let clientPort, last?.viaProxy != "127.0.0.1:\(clientPort)" {
            return LocalVerdict(level: .unknown, headline: "正在实测守护通道…", reason: "等待当前客户端入口的出口实测。", lastProbe: nil, exitProbe: nil)
        }
        if let ip = exit?.ip, ip != expectedIP {
            return LocalVerdict(level: .bad, headline: "Claude 通道出口不符", reason: "目标 \(expectedIP)，守护入口实测 \(ip)；本次通道验证未通过。", lastProbe: last, exitProbe: exit)
        }
        guard let last, Date.now.timeIntervalSince(last.at) < 45 else {
            return LocalVerdict(level: .unknown, headline: last == nil ? "正在实测守护通道…" : "通道检测已过期",
                reason: "目标出口 \(expectedIP)，等待客户端守护入口实测。",
                lastProbe: last, exitProbe: exit)
        }
        if last.ok, last.ip == expectedIP {
            return LocalVerdict(level: .good, headline: "Claude 守护网关已放行",
                reason: "经 Claude 客户端守护入口实测，出口与 \(expectedIP) 一致；账号登录和 API 调用未验证。",
                lastProbe: last, exitProbe: exit)
        }
        return LocalVerdict(level: .bad, headline: "Claude 通道探测未通过",
            reason: "守护入口探测未通过（\(last.reason ?? "连接失败")）。",
            lastProbe: last, exitProbe: exit)
    }
}

