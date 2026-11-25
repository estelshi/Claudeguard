import Foundation

// MARK: - Clawd motion system (port of the Windows badge)
//
// Source of truth: source/Claudeguard-windows/apps/guardnook-windows/renderer/style.css
// ("Clawd 动效系统") and js/views/guard.js (state reactions).
//
// Beat T = 120 ms. Every frame is a whole-cell offset or a sprite swap: no easing, no
// rotation, no scaling. Coordinates use the Windows SVG grid (viewBox -1 1 18 14), so a
// rectangle here is the same `<rect>` there. Priority: a one-shot reaction > the busy
// scan > the resting state of the tone. Reduce Motion keeps each state's still frame
// and turns a reaction into one short opacity cue.
//
// Foundation only, so the frame logic can be exercised without SwiftUI.

enum ClawdState: Equatable, Sendable {
    /// 放行: patrols left and right.
    case walk
    /// 确认中: stands still and looks around.
    case look
    /// 阻断: lies low, eyes shut, zzz.
    case sleep
    /// 未配置: stands and blinks now and then.
    case idle
}

enum ClawdReaction: String, CaseIterable, Sendable {
    case wake, startle, nod, cheer, wave, yawn

    /// Length in beats (Windows: wake 7T, startle 6T, nod 3T, cheer 7T, wave 6T, yawn 8T).
    var beats: Int {
        switch self {
            case .wake: 7
            case .startle: 6
            case .nod: 3
            case .cheer: 7
            case .wave: 6
            case .yawn: 8
        }
    }

    /// A lower rank never interrupts a higher one; rank 0 is skipped under Reduce Motion.
    var rank: Int {
        switch self {
            case .wake, .startle, .cheer: 2
            case .nod: 1
            case .wave, .yawn: 0
        }
    }

    /// The reaction a tone change plays, as guard.js picks it.
    static func forTransition(from old: ClawdState, to new: ClawdState) -> ClawdReaction? {
        switch (old, new) {
            case (.sleep, .walk), (.sleep, .look): .wake
            case (.walk, .sleep): .startle
            case (.look, .walk): .cheer
            default: nil
        }
    }
}

enum ClawdInk: Sendable {
    case shell
    case eye
    case white
}

struct ClawdRect: Equatable, Sendable {
    var x: Int
    var y: Int
    var w: Int
    var h: Int
    var ink: ClawdInk
}

/// One "z" of the zzz: a 4 × 4 glyph at (x, y) in grid units, `scale` cells per glyph pixel.
struct ClawdZ: Equatable, Sendable {
    var x: Double
    var y: Double
    var scale: Double

    /// The glyph's pixels in its own 4 × 4 grid.
    static let glyph: [(x: Int, y: Int, w: Int, h: Int)] = [(0, 0, 4, 1), (2, 1, 1, 1), (1, 2, 1, 1), (0, 3, 4, 1)]
}

struct ClawdFrame: Sendable {
    /// Body, legs, eyes, mouth and alert, in grid units (they move with the body).
    var pixels: [ClawdRect]
    /// The zzz, which float on their own.
    var zs: [ClawdZ]
    /// 1, or 0.55 during a Reduce Motion reaction cue.
    var opacity: Double
}

struct ClawdInput: Sendable {
    var state: ClawdState
    /// Beats since the reference date; drives the looping state animation.
    var beat: Int
    var reaction: ClawdReaction? = nil
    /// Beats since the reaction started.
    var reactionBeat: Int = 0
    var busy = false
    /// 0 = no blink, 1 = single blink, 2 = double blink (未配置 only).
    var blink = 0
    /// Beats since the blink started.
    var blinkBeat = 0
    var reduceMotion = false
}

enum ClawdMotion {
    /// The beat T, in seconds.
    static let beat: TimeInterval = 0.12

    static func beats(since start: Date, now: Date) -> Int {
        max(0, Int((now.timeIntervalSince(start) / beat).rounded(.down)))
    }

    static func loopBeat(_ now: Date) -> Int {
        Int((now.timeIntervalSinceReferenceDate / beat).rounded(.down))
    }

    private enum Legs { case a, b, fold, tall }
    private enum Eyes { case open, lid, closed }
    private enum Mouth { case none, small, open }

    private struct Pose {
        var me = (x: 0, y: 0)
        var top = (x: 0, y: 0)
        var gaze = (x: 0, y: 0)
        var clawL = (x: 0, y: 0)
        var clawR = (x: 0, y: 0)
        var legs = Legs.a
        var eyes = Eyes.open
        var mouth = Mouth.none
        var alert = false
        var zs: [ClawdZ] = []
    }

    // z1: translate(12.5px, 4px) scale(.5); z2: translate(14px, 1px) scale(.75).
    private static func z1(_ dx: Int, _ dy: Int) -> ClawdZ { ClawdZ(x: 12.5 + Double(dx), y: 4 + Double(dy), scale: 0.5) }
    private static func z2(_ dx: Int, _ dy: Int) -> ClawdZ { ClawdZ(x: 14 + Double(dx), y: 1 + Double(dy), scale: 0.75) }

    /// `pb-float` (24T): appears 1 low, drifts right, up, and fades at 12T.
    private static func float(_ phase: Int) -> (x: Int, y: Int)? {
        switch phase {
            case 1...3: (0, 1)
            case 4...6: (1, 0)
            case 7...9: (1, -1)
            case 10...11: (0, -2)
            default: nil
        }
    }

    private static func mod(_ value: Int, _ divisor: Int) -> Int {
        ((value % divisor) + divisor) % divisor
    }

    static func frame(_ input: ClawdInput) -> ClawdFrame {
        var pose = restingPose(input)
        var opacity = 1.0
        if let reaction = input.reaction, input.reactionBeat < reaction.beats {
            if input.reduceMotion {
                // pb-cue: one 3T opacity cue, .55 for the first half.
                if Double(input.reactionBeat) < 1.5 { opacity = 0.55 }
            } else {
                apply(reaction, beat: input.reactionBeat, state: input.state, to: &pose)
            }
        } else if input.busy && !input.reduceMotion {
            // pb-scan (4T): quick left-right scan; asleep, Clawd peeks with open eyes.
            pose.eyes = .open
            pose.gaze = (mod(input.beat, 4) < 2 ? -1 : 1, 0)
            if input.state == .sleep { pose.zs = [] }
        }
        return ClawdFrame(pixels: pixels(pose), zs: pose.zs, opacity: opacity)
    }

    private static func restingPose(_ input: ClawdInput) -> Pose {
        var pose = Pose()
        let still = input.reduceMotion
        switch input.state {
            case .walk:
                guard !still else { return pose }
                // pb-walk / pb-step-a / pb-step-b / pb-walk-look: 40T, one keyframe per 2T.
                let step = mod(input.beat / 2, 20)
                let walk: [(x: Int, y: Int)] = [
                    (-2, 0), (-1, -1), (0, 0), (1, -1), (2, 0), (1, -1), (0, 0), (-1, -1), (-2, 0), (-1, -1),
                    (0, 0), (1, -1), (2, 0), (2, 0), (2, 0), (2, 0), (2, 0), (1, -1), (0, 0), (-1, -1),
                ]
                pose.me = walk[step]
                pose.legs = [1, 3, 5, 7, 9, 11, 17, 19].contains(step) ? .b : .a
                pose.gaze = (step == 13 || step == 14 ? 1 : step == 16 ? -1 : 0, 0)
            case .look:
                guard !still else { return pose }
                // pb-look / pb-look-blink: 36T — left, centre, right, blink, right, centre, left, centre.
                let c = mod(input.beat, 36)
                switch c {
                    case 0..<10: pose.gaze = (-1, 0)
                    case 10..<12: pose.gaze = (0, 0)
                    case 12..<20: pose.gaze = (1, 0)
                    case 20: pose.gaze = (1, 0); pose.eyes = .lid
                    case 21..<25: pose.gaze = (1, 0)
                    case 25..<29: pose.gaze = (0, 0)
                    case 29..<31: pose.gaze = (-1, 0)
                    default: pose.gaze = (0, 0)
                }
            case .sleep:
                pose.me = (0, 1)
                pose.legs = .fold
                pose.eyes = .closed
                guard !still else {
                    pose.zs = [z1(0, 0), z2(0, 0)]
                    return pose
                }
                // pb-breathe / pb-float: 24T, the two z's 12T apart.
                let c = mod(input.beat, 24)
                pose.top = (0, c >= 11 ? 1 : 0)
                if let offset = float(c) { pose.zs.append(z1(offset.x, offset.y)) }
                if let offset = float(mod(c - 12, 24)) { pose.zs.append(z2(offset.x, offset.y)) }
            case .idle:
                guard !still, input.blink > 0 else { return pose }
                // pb-blink (1T) / pb-blink2 (3T): the tall eye swaps for its lower half.
                if input.blink == 1 {
                    if input.blinkBeat == 0 { pose.eyes = .lid }
                } else if input.blinkBeat == 0 || input.blinkBeat == 2 {
                    pose.eyes = .lid
                }
        }
        return pose
    }

    private static func apply(_ reaction: ClawdReaction, beat b: Int, state: ClawdState, to pose: inout Pose) {
        switch reaction {
            case .wake:
                // Big z hops up and fades, eyes open, blink, stretch, stand.
                pose.top = (0, 0)
                pose.me = (0, b < 4 ? 1 : b == 4 ? -1 : 0)
                pose.legs = b < 4 ? .fold : b == 4 ? .tall : .a
                pose.eyes = b == 0 || b == 3 ? .closed : .open
                pose.gaze = (0, 0)
                pose.clawL = (0, b == 4 ? -1 : 0)
                pose.clawR = pose.clawL
                pose.zs = b == 0 ? [z2(0, 0)] : b == 1 ? [z2(0, -1)] : []
            case .startle:
                // Hops one cell with a "!", freezes, then folds back into sleep.
                pose.top = (0, 0)
                pose.me = (0, b == 0 ? -1 : b < 4 ? 0 : 1)
                pose.legs = b < 3 ? .a : .fold
                pose.eyes = b < 3 ? .open : .closed
                pose.gaze = (0, 0)
                pose.alert = b < 3
                pose.zs = []
            case .nod:
                // Eyes drop one cell for two beats.
                pose.eyes = .open
                pose.gaze = (0, b < 2 ? 1 : 0)
            case .cheer:
                // Claws up and out, smiling eyes, two small hops.
                let hops = [-1, -2, 0, -1, -2, 0, 0]
                pose.top = (0, 0)
                pose.me = (0, hops[min(b, hops.count - 1)])
                pose.legs = .a
                pose.clawL = b < 6 ? (-1, -2) : (0, 0)
                pose.clawR = b < 6 ? (1, -2) : (0, 0)
                pose.eyes = b < 6 ? .closed : .open
                pose.gaze = (0, 0)
                pose.zs = []
            case .wave:
                // The right claw waves twice; the rest of the state keeps going.
                let wave: [(x: Int, y: Int)] = [(0, -1), (0, -2), (1, -2), (0, -2), (1, -2), (0, -1)]
                pose.clawR = wave[min(b, wave.count - 1)]
            case .yawn:
                // Stops, shuts its eyes, mouth opens for two frames.
                pose.me = (0, 0)
                pose.top = (0, 0)
                pose.legs = .a
                pose.eyes = b < 7 ? .closed : .open
                pose.gaze = (0, 0)
                pose.mouth = b == 0 || b == 6 ? .small : (1...5).contains(b) ? .open : .none
        }
    }

    private static func pixels(_ pose: Pose) -> [ClawdRect] {
        var out: [ClawdRect] = []
        let mx = pose.me.x, my = pose.me.y
        func add(_ x: Int, _ y: Int, _ w: Int, _ h: Int, _ ink: ClawdInk, dx: Int = 0, dy: Int = 0) {
            out.append(ClawdRect(x: x + mx + dx, y: y + my + dy, w: w, h: h, ink: ink))
        }
        // Legs move with the body only.
        switch pose.legs {
            case .a: for x in [4, 6, 8, 10] { add(x, 12, 1, 2, .shell) }
            case .b: for (x, h) in [(4, 1), (6, 2), (8, 1), (10, 2)] { add(x, 12, 1, h, .shell) }
            case .fold: add(4, 12, 7, 1, .shell)
            case .tall: for x in [4, 6, 8, 10] { add(x, 12, 1, 3, .shell) }
        }
        // The top (body, claws, face) breathes on its own.
        let tx = pose.top.x, ty = pose.top.y
        add(3, 6, 9, 6, .shell, dx: tx, dy: ty)
        add(1, 8, 2, 2, .shell, dx: tx + pose.clawL.x, dy: ty + pose.clawL.y)
        add(12, 8, 2, 2, .shell, dx: tx + pose.clawR.x, dy: ty + pose.clawR.y)
        let gx = tx + pose.gaze.x, gy = ty + pose.gaze.y
        switch pose.eyes {
            case .open:
                add(5, 7, 1, 2, .eye, dx: gx, dy: gy)
                add(9, 7, 1, 2, .eye, dx: gx, dy: gy)
            case .lid:
                add(5, 8, 1, 1, .eye, dx: gx, dy: gy)
                add(9, 8, 1, 1, .eye, dx: gx, dy: gy)
            case .closed:
                add(4, 8, 2, 1, .eye, dx: tx, dy: ty)
                add(9, 8, 2, 1, .eye, dx: tx, dy: ty)
        }
        switch pose.mouth {
            case .none: break
            case .small: add(7, 10, 1, 1, .eye, dx: tx, dy: ty)
            case .open: add(7, 9, 1, 2, .eye, dx: tx, dy: ty)
        }
        if pose.alert {
            add(7, 1, 1, 2, .white, dx: tx, dy: ty)
            add(7, 4, 1, 1, .white, dx: tx, dy: ty)
        }
        return out
    }
}
