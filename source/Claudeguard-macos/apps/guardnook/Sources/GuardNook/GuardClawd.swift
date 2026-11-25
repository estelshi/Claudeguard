import SwiftUI

// MARK: - Clawd badge (aligned with Windows `.state-badge`)
//
// A 64 pt rounded container with the tone's gradient (Windows colours, washed onto the
// dark card colour) and a top-left highlight, holding the pixel Clawd. Frames come from
// ClawdMotion (120 ms beat, stepped, whole cells); this view only keeps time, picks the
// reactions the way js/views/guard.js does, and draws the frame.

struct GuardClawdBadge: View {
    let tone: GuardTone
    /// A check is running (重新检测 / 重新验证 / 环境检查): eyes scan.
    var busy = false
    /// The current 连续验证 count; a step up while confirming plays a nod.
    var progress: Int? = nil
    var progressTarget = 3
    var size: CGFloat = 64

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var reaction: ClawdReaction?
    @State private var reactionStart = Date.distantPast
    @State private var blink = 0
    @State private var blinkStart = Date.distantPast
    @State private var lastWave = Date.distantPast
    @State private var lastActivity = Date()
    @State private var yawned = false

    private static let idleBeforeYawn: TimeInterval = 45
    private static let waveGap: TimeInterval = 4

    var body: some View {
        TimelineView(.periodic(from: .now, by: ClawdMotion.beat)) { context in
            ClawdCanvas(frame: ClawdMotion.frame(input(at: context.date)))
        }
        .frame(width: size, height: size)
        .background(container)
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onHover { inside in
            guard inside else { return }
            noteActivity()
            wave()
        }
        .onChange(of: tone) { old, new in
            noteActivity()
            if let next = ClawdReaction.forTransition(from: old.clawd, to: new.clawd) {
                react(next)
            } else {
                reaction = nil
            }
        }
        .onChange(of: progress) { old, new in
            guard tone == .warn, let new, new > (old ?? 0), new < progressTarget else { return }
            react(.nod)
        }
        .task(id: tone) { await idleLoop() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Clawd · \(tone.label)"))
    }

    private var container: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        return ZStack {
            shape.fill(Color(guardHex: 0x1B1C21))
            shape
                .fill(LinearGradient(colors: tone.badgeColors, startPoint: .topLeading, endPoint: .bottomTrailing))
                .opacity(0.42)
            shape.fill(
                RadialGradient(
                    colors: [Color.white.opacity(0.16), Color.white.opacity(0)],
                    center: UnitPoint(x: 0.2, y: 0),
                    startRadius: 0,
                    endRadius: size * 0.6
                )
            )
            shape.strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        }
        // The only smooth change, as on Windows: the badge colour cross-fades.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: tone)
    }

    private func input(at now: Date) -> ClawdInput {
        var input = ClawdInput(state: tone.clawd, beat: ClawdMotion.loopBeat(now))
        input.reduceMotion = reduceMotion
        input.busy = busy
        if let reaction {
            let beats = ClawdMotion.beats(since: reactionStart, now: now)
            if beats < reaction.beats {
                input.reaction = reaction
                input.reactionBeat = beats
            }
        }
        if blink > 0 {
            let beats = ClawdMotion.beats(since: blinkStart, now: now)
            if beats < (blink == 2 ? 3 : 1) {
                input.blink = blink
                input.blinkBeat = beats
            }
        }
        return input
    }

    private var activeReaction: ClawdReaction? {
        guard let reaction else { return nil }
        return ClawdMotion.beats(since: reactionStart, now: .now) < reaction.beats ? reaction : nil
    }

    private func react(_ next: ClawdReaction) {
        if reduceMotion && next.rank == 0 { return }
        if let current = activeReaction, current.rank > next.rank { return }
        reaction = next
        reactionStart = .now
    }

    private func wave() {
        guard tone != .bad, Date.now.timeIntervalSince(lastWave) >= Self.waveGap else { return }
        lastWave = .now
        react(.wave)
    }

    private func noteActivity() {
        lastActivity = .now
        yawned = false
    }

    /// Random blinks while unconfigured (every 3–6 s, about a quarter of them double) and
    /// one yawn after 45 s without activity while protected.
    private func idleLoop() async {
        var nextBlink = Date.now.addingTimeInterval(Double.random(in: 3...6))
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(500))
            if Task.isCancelled { return }
            let now = Date.now
            if tone == .idle, now >= nextBlink {
                nextBlink = now.addingTimeInterval(Double.random(in: 3...6))
                if !reduceMotion && activeReaction == nil {
                    blink = Double.random(in: 0..<1) < 0.25 ? 2 : 1
                    blinkStart = now
                }
            }
            if tone == .good, !yawned, activeReaction == nil,
               now.timeIntervalSince(lastActivity) >= Self.idleBeforeYawn {
                yawned = true
                react(.yawn)
            }
        }
    }
}

/// Draws a ClawdFrame on a 3 pt grid (whole pixels at 2×). The SVG grid is centred in
/// the badge; the body sits 1.5 cells high, as `.pb-me` does on Windows.
struct ClawdCanvas: View {
    let frame: ClawdFrame

    private static let cell: CGFloat = 3
    private static let shell = Color(guardHex: 0xD97757)
    private static let eye = Color(guardHex: 0x1D1A18)
    private static let white = Color.white

    var body: some View {
        Canvas { context, size in
            let cell = ClawdCanvas.cell
            // viewBox -1 1 18 14
            let originX = ((size.width - 18 * cell) / 2).rounded()
            let originY = ((size.height - 14 * cell) / 2).rounded()
            // Body nudge: centred horizontally, 1.5 cells up (whole pixels at 2×).
            let bodyX = originX + 1.5
            let bodyY = originY - 4.5
            var shell = Path()
            var eye = Path()
            var white = Path()
            for pixel in frame.pixels {
                let rect = CGRect(
                    x: bodyX + CGFloat(pixel.x + 1) * cell,
                    y: bodyY + CGFloat(pixel.y - 1) * cell,
                    width: CGFloat(pixel.w) * cell,
                    height: CGFloat(pixel.h) * cell
                )
                switch pixel.ink {
                    case .shell: shell.addRect(rect)
                    case .eye: eye.addRect(rect)
                    case .white: white.addRect(rect)
                }
            }
            for z in frame.zs {
                // Glyph pixel rounded to half points so it lands on device pixels at 2×.
                let unit = max(1, (CGFloat(z.scale) * cell * 2).rounded() / 2)
                let x = originX + CGFloat(z.x + 1) * cell
                let y = originY + CGFloat(z.y - 1) * cell
                for part in ClawdZ.glyph {
                    white.addRect(CGRect(
                        x: x + CGFloat(part.x) * unit,
                        y: y + CGFloat(part.y) * unit,
                        width: CGFloat(part.w) * unit,
                        height: CGFloat(part.h) * unit
                    ))
                }
            }
            context.fill(shell, with: .color(ClawdCanvas.shell))
            context.fill(eye, with: .color(ClawdCanvas.eye))
            context.fill(white, with: .color(ClawdCanvas.white))
        }
        .opacity(frame.opacity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
