import NookApp
import SwiftUI

// MARK: - Dark design tokens (work/mac-redesign/VISUAL-SPEC.md)
//
// The Windows design language (pill navigation, gradient network cards, huge thin
// numbers) translated onto a charcoal panel. main.swift pins the chrome palette to
// dark, so every colour here is written for a dark background only, and nothing is
// ever pure black.

extension Color {
    /// `0xRRGGBB` in sRGB.
    init(guardHex hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

/// Layout tokens shared by every page: 680 × 460 panel (38 top bar + 422 content).
enum GuardMetrics {
    static let contentHeight: CGFloat = 422
    static let horizontal: CGFloat = 22
    static let top: CGFloat = 24
    static let bottom: CGFloat = 22
    /// Between big sections.
    static let section: CGFloat = 28
    /// Between cards, and from a section title to its cards.
    static let gap: CGFloat = 12
    static let cardRadius: CGFloat = 18
    static let networkCardHeight: CGFloat = 128
    static let setupWindow = CGSize(width: 680, height: 560)
}

/// Text and status colours. One accent per view: the light pill (`GuardInk.accentFill`).
enum GuardInk {
    static let primary = Color.white.opacity(0.92)
    static let secondary = Color.white.opacity(0.60)
    static let tertiary = Color.white.opacity(0.38)
    static let idleTitle = Color.white.opacity(0.80)
    /// Warm red text: blocked headline and the measured exit that broke the rule.
    static let badText = Color(guardHex: 0xFF8A82)
    static let success = Color(guardHex: 0x30D158)
    static let failure = Color(guardHex: 0xFF453A)
    /// Mid blue from the existing tile fill, for a fixable environment-row status.
    static let repair = Color(guardHex: 0x4C93DA)
    /// Lighter companion of `repair`, same role as `badText` beside `failure`.
    static let repairText = Color(guardHex: 0x8BB9E7)
    static let warning = Color(guardHex: 0xF2A93B)
    static let checkFill = Color(guardHex: 0x30C77B, opacity: 0.16)
    static let checkMark = Color(guardHex: 0x5FDB9C)
    static let hairline = Color.white.opacity(0.07)
    static let strongLine = Color.white.opacity(0.12)
    static let accentFill = Color.white.opacity(0.92)
    static let accentText = Color(guardHex: 0x0F1013)
    static let panelTop = Color(guardHex: 0x000000)
    static let panelBottom = Color(guardHex: 0x000000)
}

/// Font roles. 阿里巴巴普惠体 3.0 is not bundled with the Mac app yet, so these use the
/// system font; swap the body of `make` once the font ships in Resources.
enum GuardFont {
    static func make(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static let pageTitle = make(22, .semibold)
    static let wizardTitle = make(20, .semibold)
    static let sectionTitle = make(13, .semibold)
    static let label = make(12, .medium)
    static let body = make(12)
    static let meta = make(11)
    static func number(_ size: CGFloat) -> Font { make(size, .light).monospacedDigit() }
}

/// The gradient fills of the Windows tiles, deepened a step so white text reads on black.
enum GuardFill {
    case teal
    case violet
    case sunset
    case blue
    case mist

    var colors: [Color] {
        switch self {
            case .teal: [Color(guardHex: 0x3F7E84), Color(guardHex: 0x5E9E9C), Color(guardHex: 0x7DB5AE)]
            case .violet: [Color(guardHex: 0x7A5AD8), Color(guardHex: 0xB46ACF), Color(guardHex: 0xDE7FAE)]
            case .sunset: [Color(guardHex: 0xD9699F), Color(guardHex: 0xE5826F), Color(guardHex: 0xE9A04B)]
            case .blue: [Color(guardHex: 0x4C93DA), Color(guardHex: 0x4874DC), Color(guardHex: 0x3D58CF)]
            case .mist: [Color(guardHex: 0x4A4D57), Color(guardHex: 0x5B5F6A), Color(guardHex: 0x6C707B)]
        }
    }

    var gradient: LinearGradient {
        LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    var stroke: Color {
        switch self {
            case .blue: colors[1].opacity(0.30)
            default: colors[1].opacity(0.28)
        }
    }
}

/// One state, as the hero shows it: 放行 / 确认中 / 阻断 / 未配置.
enum GuardTone: Equatable {
    case good
    case warn
    case bad
    case idle

    init(_ verdict: LocalVerdict) {
        switch verdict.level {
            case .good: self = .good
            case .caution: self = .warn
            case .bad: self = .bad
            case .unknown: self = .idle
        }
    }

    init(_ status: GuardStatus?) {
        guard let status else {
            self = .idle
            return
        }
        if status.verifiedNow {
            self = .good
        } else if status.manual == true || status.phase == "blocked" {
            self = .bad
        } else if status.enabled == true {
            self = .warn
        } else {
            self = .idle
        }
    }

    /// Windows `.state-badge` gradients (renderer/style.css), per tone.
    var badgeColors: [Color] {
        switch self {
            case .good: [Color(guardHex: 0x8DBDBF), Color(guardHex: 0xA6CFCB), Color(guardHex: 0xC4E2DA)]
            case .warn: [Color(guardHex: 0xF8A7C6), Color(guardHex: 0xFBB59C), Color(guardHex: 0xFFD08A)]
            case .bad: [Color(guardHex: 0x8F7AE8), Color(guardHex: 0xB98AE6), Color(guardHex: 0xEA9EC8)]
            case .idle: [Color(guardHex: 0xD9DBE3), Color(guardHex: 0xE6E3EE), Color(guardHex: 0xEFE9EF)]
        }
    }

    var clawd: ClawdState {
        switch self {
            case .good: .walk
            case .warn: .look
            case .bad: .sleep
            case .idle: .idle
        }
    }

    var label: String {
        switch self {
            case .good: "放行"
            case .warn: "确认中"
            case .bad: "阻断"
            case .idle: "未配置"
        }
    }
}

// MARK: - Surfaces

/// Panel background: solid #000000, matching the OpenNook chrome.
struct GuardPanelBackground: View {
    var body: some View {
        GuardInk.panelTop
            .ignoresSafeArea()
    }
}

/// Card: #17181C with a top light (white 3.5% → 0 over the first 70%) and a 1 px
/// white 7% inner stroke.
struct GuardCardModifier: ViewModifier {
    var radius: CGFloat = GuardMetrics.cardRadius
    var raised = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                ZStack {
                    shape.fill(Color(guardHex: raised ? 0x1F2025 : 0x17181C))
                    shape.fill(
                        LinearGradient(
                            stops: [
                                .init(color: Color.white.opacity(raised ? 0.06 : 0.035), location: 0),
                                .init(color: Color.white.opacity(raised ? 0.03 : 0), location: 0.7),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                }
            }
            .overlay(shape.strokeBorder(Color.white.opacity(raised ? 0.16 : 0.07), lineWidth: 1))
    }
}

/// Text field / input well: white 4.5% with a white 7% hairline, radius 10.
struct GuardFieldModifier: ViewModifier {
    var invalid = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        content
            .textFieldStyle(.plain)
            .font(GuardFont.body)
            .foregroundStyle(GuardInk.primary)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(shape.fill(Color.white.opacity(0.045)))
            .overlay(shape.strokeBorder(invalid ? GuardInk.badText.opacity(0.7) : GuardInk.hairline, lineWidth: 1))
    }
}

extension View {
    func guardCard(radius: CGFloat = GuardMetrics.cardRadius, raised: Bool = false) -> some View {
        modifier(GuardCardModifier(radius: radius, raised: raised))
    }

    func guardField(invalid: Bool = false) -> some View {
        modifier(GuardFieldModifier(invalid: invalid))
    }
}

// MARK: - Buttons

/// Pills. `prominent` is the single light accent of a view (white 92% with dark text);
/// the rest are neutral (white 6% fill, white 12% hairline).
struct GuardPillButtonStyle: ButtonStyle {
    var prominent = false
    var height: CGFloat = 28
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(GuardFont.make(12, prominent ? .semibold : .medium))
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: height)
            .foregroundStyle(prominent ? GuardInk.accentText : GuardInk.primary)
            .background(Capsule().fill(prominent ? GuardInk.accentFill : Color.white.opacity(0.06)))
            .overlay(Capsule().strokeBorder(prominent ? Color.clear : GuardInk.strongLine, lineWidth: 1))
            .contentShape(Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.4)
    }
}

/// A round neutral icon button (refresh, export, clear).
struct GuardCircleButtonStyle: ButtonStyle {
    var size: CGFloat = 28
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(GuardFont.make(11, .semibold))
            .foregroundStyle(GuardInk.secondary)
            .frame(width: size, height: size)
            .background(Circle().fill(Color.white.opacity(0.06)))
            .overlay(Circle().strokeBorder(GuardInk.strongLine, lineWidth: 1))
            .contentShape(Circle())
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.4)
    }
}

/// A segmented control drawn as the tab pill: options in a faint capsule, the chosen one
/// a light capsule with dark text.
struct GuardSegmented<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    var height: CGFloat = 26

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let selected = option.0 == selection
                Button {
                    selection = option.0
                } label: {
                    Text(option.1)
                        .font(GuardFont.make(11.5, selected ? .semibold : .medium))
                        .foregroundStyle(selected ? GuardInk.accentText : GuardInk.secondary)
                        .lineLimit(1)
                        .padding(.horizontal, 12)
                        .frame(height: height - 4)
                        .background(Capsule().fill(selected ? GuardInk.accentFill : Color.clear))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().strokeBorder(GuardInk.hairline, lineWidth: 1))
    }
}

// MARK: - Text blocks

/// Page header for 环境 / 日志 / 设置: title 22/600, one line 12/400, trailing actions.
struct GuardPageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    var subtitleColor: Color = GuardInk.secondary
    private let trailing: Trailing

    init(title: String, subtitle: String, subtitleColor: Color = GuardInk.secondary,
         @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.subtitleColor = subtitleColor
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(GuardFont.pageTitle)
                    .foregroundStyle(GuardInk.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(GuardFont.body)
                    .foregroundStyle(subtitleColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(subtitle)
            }
            Spacer(minLength: 8)
            trailing
        }
    }
}

extension GuardPageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String, subtitleColor: Color = GuardInk.secondary) {
        self.init(title: title, subtitle: subtitle, subtitleColor: subtitleColor) { EmptyView() }
    }
}

/// Section heading: 13/600 title, optional trailing content (age, refresh).
struct GuardSectionTitle<Trailing: View>: View {
    let title: String
    private let trailing: Trailing

    init(title: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(title)
                .font(GuardFont.sectionTitle)
                .foregroundStyle(GuardInk.primary)
            Spacer(minLength: 8)
            trailing
        }
    }
}

extension GuardSectionTitle where Trailing == EmptyView {
    init(title: String) {
        self.init(title: title) { EmptyView() }
    }
}

/// A status dot with the 3 pt 18% halo used on success.
struct GuardStatusDot: View {
    let color: Color
    var halo = true

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .padding(3)
            .background(Circle().fill(halo ? color.opacity(0.18) : Color.clear))
            .accessibilityHidden(true)
    }
}

/// Round check / cross used by wizard checklists.
struct GuardCheckMark: View {
    /// nil = pending.
    let passed: Bool?

    var body: some View {
        ZStack {
            Circle().fill(fill)
            Image(systemName: symbol)
                .font(GuardFont.make(8, .bold))
                .foregroundStyle(tint)
        }
        .frame(width: 18, height: 18)
        .accessibilityLabel(Text(passed == true ? "通过" : passed == false ? "未通过" : "待检测"))
    }

    private var symbol: String {
        switch passed {
            case .some(true): "checkmark"
            case .some(false): "xmark"
            case .none: "ellipsis"
        }
    }

    private var tint: Color {
        switch passed {
            case .some(true): GuardInk.checkMark
            case .some(false): GuardInk.badText
            case .none: GuardInk.tertiary
        }
    }

    private var fill: Color {
        switch passed {
            case .some(true): GuardInk.checkFill
            case .some(false): GuardInk.failure.opacity(0.16)
            case .none: Color.white.opacity(0.06)
        }
    }
}

/// Big thin number with a dimmed unit: value 30/300, unit 15/300 at white 38%.
struct GuardNumber: View {
    let value: String
    var unit: String? = nil
    var size: CGFloat = 30
    var color: Color = GuardInk.primary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(GuardFont.number(size))
                .tracking(-size * 0.02)
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let unit {
                Text(unit)
                    .font(GuardFont.make(size / 2, .light))
                    .foregroundStyle(GuardInk.tertiary)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - Cards

/// Faint concentric rings in a gradient card's lower-right corner (every 28 pt).
private struct GuardTileRings: View {
    private let diameters: [CGFloat] = [56, 112, 168, 224]

    var body: some View {
        ZStack {
            ForEach(diameters, id: \.self) { diameter in
                Circle()
                    .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
                    .frame(width: diameter, height: diameter)
            }
        }
        .offset(x: 84, y: 84)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Gradient network card (Windows finished design, dark): dot + title, IP 22/300, one
/// source line. 128 pt high, radius 18.
struct GuardTile: View {
    let title: String
    let value: String
    let detail: String
    var fill: GuardFill = .teal
    var dot: Color? = nil
    var valueSize: CGFloat = 22
    /// Placeholder values (未放行, 检测中…) read quieter than an address.
    var valueDimmed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if let dot {
                    GuardStatusDot(color: dot)
                        .padding(-3)
                }
                Text(title)
                    .font(GuardFont.make(12, .semibold))
                    .foregroundStyle(Color.white.opacity(0.95))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(value)
                .font(GuardFont.number(valueSize))
                .foregroundStyle(Color.white.opacity(valueDimmed ? 0.55 : 0.95))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .textSelection(.enabled)
            Text(detail)
                .font(GuardFont.meta)
                .foregroundStyle(Color.white.opacity(0.62))
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.top, 3)
                .help(detail)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .background {
            ZStack {
                Color(guardHex: 0x1B1C21)
                fill.gradient.opacity(0.30)
                GuardTileRings()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: GuardMetrics.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: GuardMetrics.cardRadius, style: .continuous)
                .strokeBorder(fill.stroke, lineWidth: 1)
        }
    }
}

/// KPI card (Vexto): label 11.5/500 top-left, optional ↗ top-right, content at the
/// bottom (big number, then a footnote or a 14 pt spark strip).
struct GuardKPICard<Content: View>: View {
    let label: String
    var onOpen: (() -> Void)? = nil
    var openHelp: String? = nil
    private let content: Content

    init(label: String, onOpen: (() -> Void)? = nil, openHelp: String? = nil, @ViewBuilder content: () -> Content) {
        self.label = label
        self.onOpen = onOpen
        self.openHelp = openHelp
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                Text(label)
                    .font(GuardFont.make(11.5, .medium))
                    .foregroundStyle(GuardInk.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let onOpen {
                    Button(action: onOpen) {
                        Image(systemName: "arrow.up.right")
                            .font(GuardFont.make(10, .semibold))
                            .foregroundStyle(GuardInk.tertiary)
                            .frame(width: 18, height: 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(openHelp ?? "在日志中查看")
                    .accessibilityLabel(Text(openHelp ?? "在日志中查看"))
                }
            }
            Spacer(minLength: 6)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .guardCard()
    }
}

/// Probe results as a neutral spark strip (white 22%); failed probes are warm red.
struct GuardSparkStrip: View {
    /// Oldest first. nil = no reading for that slot.
    let results: [Bool?]
    var slots = 40
    var height: CGFloat = 14

    var body: some View {
        let recent = Array(results.suffix(slots))
        let padding = max(0, slots - recent.count)
        GeometryReader { proxy in
            let spacing: CGFloat = 2
            let width = max(1, (proxy.size.width - spacing * CGFloat(slots - 1)) / CGFloat(slots))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<slots, id: \.self) { index in
                    let value: Bool? = index < padding ? nil : recent[index - padding]
                    RoundedRectangle(cornerRadius: 1, style: .continuous)
                        .fill(tint(value, slot: index, padding: padding))
                        .frame(width: width, height: value == nil ? height * 0.5 : height)
                }
            }
            .frame(height: height)
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("最近 \(recent.count) 次通道验证，\(recent.filter { $0 == false }.count) 次失败"))
    }

    private func tint(_ value: Bool?, slot: Int, padding: Int) -> Color {
        switch value {
            case .some(true): Color.white.opacity(0.22)
            case .some(false): GuardInk.badText
            case .none: Color.white.opacity(0.08)
        }
    }
}
