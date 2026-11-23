import NookApp
import SwiftUI

// MARK: - Dark design tokens
//
// The Windows design language (pill navigation, a headline with a coloured state
// badge, gradient tiles, huge thin numbers) translated onto the nook's black panel.
// main.swift pins the chrome palette to dark, so these colours are written for a
// dark background only.

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
}

/// One state, as the headline badge shows it: 放行 / 确认中 / 阻断 / 未配置.
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

    var fill: GuardFill {
        switch self {
            case .good: GuardFill.teal
            case .warn: GuardFill.sunset
            case .bad: GuardFill.violet
            case .idle: GuardFill.mist
        }
    }

    var mood: GuardClawd.Mood {
        switch self {
            case .good: GuardClawd.Mood.walk
            case .warn: GuardClawd.Mood.look
            case .bad: GuardClawd.Mood.sleep
            case .idle: GuardClawd.Mood.blink
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

// MARK: - Clawd pixel crab

/// Clawd-style pixel crab drawn from a small bitmap: walks while Claude is admitted,
/// looks around while confirming, sleeps while blocked and blinks when unconfigured.
/// Reduce Motion freezes it on its first frame.
struct GuardClawd: View {
    enum Mood {
        case walk
        case look
        case sleep
        case blink
    }

    let mood: Mood
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.45)) { context in
            let tick = reduceMotion ? 0 : Int(context.date.timeIntervalSinceReferenceDate / 0.45)
            ZStack(alignment: .topTrailing) {
                GuardPixelSprite(rows: GuardClawd.sprite(for: mood, tick: tick))
                if mood == .sleep {
                    Text(tick % 2 == 0 ? "z" : "zz")
                        .font(.system(size: 8, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.white)
                        .offset(x: 7, y: -9)
                }
            }
        }
        .accessibilityHidden(true)
    }

    // 14 columns × 7 rows. "#" shell, "o" eye, "-" closed eye, "." empty.
    private static let top = "..##########.."
    private static let eyesOpen = "..#o######o#.."
    private static let eyesLeft = "..o######o##.."
    private static let eyesRight = "..##o######o.."
    private static let eyesClosed = "..#-######-#.."
    private static let arms = "##############"
    private static let lower = "..##########.."
    private static let legsA = "..#.#....#.#.."
    private static let legsB = "...#.#..#.#..."
    private static let blank = ".............."

    static func sprite(for mood: Mood, tick: Int) -> [String] {
        switch mood {
            case .walk:
                let legs = tick % 2 == 0 ? legsA : legsB
                return [top, eyesOpen, arms, arms, lower, legs, legs]
            case .look:
                let phase = tick % 4
                let eyes = phase == 1 ? eyesLeft : phase == 3 ? eyesRight : eyesOpen
                return [top, eyes, arms, arms, lower, legsA, legsA]
            case .sleep:
                return [blank, top, eyesClosed, arms, arms, lower, legsA]
            case .blink:
                let eyes = tick % 6 == 5 ? eyesClosed : eyesOpen
                return [top, eyes, arms, arms, lower, legsA, legsA]
        }
    }
}

/// Draws a bitmap of characters as square pixels. Shell and eye pixels are each filled
/// as one path, so neighbouring squares never show hairline seams.
struct GuardPixelSprite: View {
    let rows: [String]

    private static let shell = Color(guardHex: 0xD97757)
    private static let eye = Color(guardHex: 0x2A1712)

    var body: some View {
        Canvas { context, size in
            let columns = rows.map { $0.count }.max() ?? 0
            guard columns > 0, !rows.isEmpty else { return }
            let raw = min(size.width / CGFloat(columns), size.height / CGFloat(rows.count))
            let cell = raw >= 3 ? raw.rounded(.down) : raw
            let originX = (size.width - cell * CGFloat(columns)) / 2
            let originY = (size.height - cell * CGFloat(rows.count)) / 2
            var shellPath = Path()
            var eyePath = Path()
            for (y, row) in rows.enumerated() {
                for (x, pixel) in row.enumerated() {
                    let rect = CGRect(
                        x: originX + CGFloat(x) * cell,
                        y: originY + CGFloat(y) * cell,
                        width: cell,
                        height: cell
                    )
                    switch pixel {
                        case "#":
                            shellPath.addRect(rect)
                        case "o":
                            eyePath.addRect(rect)
                        case "-":
                            shellPath.addRect(rect)
                            eyePath.addRect(CGRect(x: rect.minX, y: rect.midY, width: cell, height: cell / 2))
                        default:
                            break
                    }
                }
            }
            context.fill(shellPath, with: .color(GuardPixelSprite.shell))
            context.fill(eyePath, with: .color(GuardPixelSprite.eye))
        }
    }
}

// MARK: - Components

/// The state mark in front of every headline: the bare crab on the panel, no backing
/// tile (her ask 2026-11-23). The mood carries the state; the headline names it.
struct GuardStateBadge: View {
    let tone: GuardTone
    var size: CGFloat = 46

    var body: some View {
        GuardClawd(mood: tone.mood)
            .frame(width: size, height: size * 0.68)
            .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(tone.label))
    }
}

/// Headline row: badge, semibold headline, one muted reason, optional trailing action.
struct GuardHero<Trailing: View>: View {
    let tone: GuardTone
    let headline: String
    let reason: String
    private let trailing: Trailing
    @Environment(\.nookResolvedTheme) private var theme

    init(tone: GuardTone, headline: String, reason: String, @ViewBuilder trailing: () -> Trailing) {
        self.tone = tone
        self.headline = headline
        self.reason = reason
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            GuardStateBadge(tone: tone)
            VStack(alignment: .leading, spacing: 4) {
                Text(headline)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(theme.primaryLabel)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(reason)
                    .font(.system(size: 11.5))
                    .foregroundStyle(theme.secondaryLabel)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing
        }
    }
}

extension GuardHero where Trailing == EmptyView {
    init(tone: GuardTone, headline: String, reason: String) {
        self.init(tone: tone, headline: headline, reason: reason) { EmptyView() }
    }
}

/// Faint concentric rings in a tile's lower-right corner, as on the Windows tiles.
private struct GuardTileRings: View {
    private let diameters: [CGFloat] = [64, 104, 144]

    var body: some View {
        ZStack {
            ForEach(diameters, id: \.self) { diameter in
                Circle()
                    .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
                    .frame(width: diameter, height: diameter)
            }
        }
        .offset(x: 52, y: 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Gradient tile: title on top, a huge thin value, one detail line.
struct GuardTile: View {
    let title: String
    let value: String
    let detail: String
    var fill: GuardFill = .teal
    var dot: Color? = nil
    var valueSize: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if let dot {
                    Circle()
                        .fill(dot)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.9), lineWidth: 1))
                }
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: valueSize, weight: .light).monospacedDigit())
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(detail)
                .font(.system(size: 10))
                .foregroundStyle(Color.white.opacity(0.62))
                .lineLimit(1)
                .padding(.top, 3)
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
        .padding(14)
        .background {
            // Toned down (her ask 2026-11-23): a dark card with the hue washed over it,
            // instead of the full-strength gradient.
            ZStack {
                Color(guardHex: 0x1B1C21)
                fill.gradient.opacity(0.30)
                GuardTileRings()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(fill.colors[1].opacity(0.28), lineWidth: 1)
        }
    }
}

/// A big thin number with its label underneath.
struct GuardKPI: View {
    let value: String
    var unit: String? = nil
    let label: String
    var tint: Color? = nil
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.system(size: 32, weight: .light).monospacedDigit())
                    .foregroundStyle(tint ?? theme.primaryLabel)
                    .lineLimit(1)
                if let unit {
                    Text(unit)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.tertiaryLabel)
                }
            }
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(theme.tertiaryLabel)
                .lineLimit(1)
        }
    }
}

/// Section heading: semibold title, optional muted note on the right.
struct GuardSectionTitle: View {
    let title: String
    var note: String? = nil
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(theme.primaryLabel)
            Spacer(minLength: 8)
            if let note {
                Text(note)
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundStyle(theme.quaternaryLabel)
                    .lineLimit(1)
            }
        }
    }
}

/// The dark card every list sits in.
struct GuardSurfaceModifier: ViewModifier {
    let padding: CGFloat
    let radius: CGFloat
    @Environment(\.nookResolvedTheme) private var theme

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(theme.subtleFill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(theme.subtleStroke))
    }
}

extension View {
    func guardSurface(padding: CGFloat = 12, radius: CGFloat = 16) -> some View {
        modifier(GuardSurfaceModifier(padding: padding, radius: radius))
    }
}

/// Main actions. `prominent` is the light-on-dark equivalent of the Windows black
/// primary button: a near-white pill with dark text.
struct GuardPillButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: prominent ? .semibold : .medium))
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: 28)
            .foregroundStyle(prominent ? Color.black : Color.white.opacity(0.9))
            .background(Capsule().fill(prominent ? Color.white.opacity(0.94) : Color.white.opacity(0.08)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(prominent ? 0 : 0.12)))
            .contentShape(Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.4)
    }
}
