import Foundation

// Frame checks for the ported Clawd motion system (ClawdMotion.swift). Foundation only:
// swiftc -parse-as-library Sources/GuardNook/ClawdMotion.swift Tests/ClawdChecks.swift

@main
enum ClawdChecks {
    static var failures = 0

    static func check(_ condition: Bool, _ message: String) {
        if !condition { failures += 1; print("FAIL:", message) }
    }

    static func main() {
        let states: [ClawdState] = [.walk, .look, .sleep, .idle]
        for state in states {
            for beat in -50..<200 {
                for reduce in [false, true] {
                    let frame = ClawdMotion.frame(ClawdInput(state: state, beat: beat, busy: beat % 7 == 0,
                                                             blink: beat % 3, blinkBeat: beat % 4, reduceMotion: reduce))
                    check(frame.pixels.contains { $0.w == 9 && $0.h == 6 }, "body \(state) \(beat)")
                    for reaction in ClawdReaction.allCases {
                        for step in 0..<12 {
                            let reacted = ClawdMotion.frame(ClawdInput(state: state, beat: beat, reaction: reaction,
                                                                       reactionBeat: step, reduceMotion: reduce))
                            check(reacted.pixels.count >= 6, "pixels \(state) \(reaction) \(step)")
                            if reduce {
                                let cue = step < 2 && step < reaction.beats
                                check(reacted.opacity == (cue ? 0.55 : 1), "cue \(reaction) \(step)")
                            }
                        }
                    }
                }
            }
        }
        // Whole cells only: every rectangle is on the integer grid by construction; the
        // walk loop returns to its first frame after 40 beats (4.8 s).
        check(ClawdMotion.frame(ClawdInput(state: .walk, beat: 0)).pixels
              == ClawdMotion.frame(ClawdInput(state: .walk, beat: 40)).pixels, "walk loops at 40T")
        // The two z's of the sleep loop never show at once; Reduce Motion shows both, still.
        for beat in 0..<24 {
            check(ClawdMotion.frame(ClawdInput(state: .sleep, beat: beat)).zs.count <= 1, "zzz overlap \(beat)")
        }
        check(ClawdMotion.frame(ClawdInput(state: .sleep, beat: 5, reduceMotion: true)).zs.count == 2, "still zzz")
        // Reduce Motion freezes each state on one frame.
        for state in states {
            let first = ClawdMotion.frame(ClawdInput(state: state, beat: 0, reduceMotion: true)).pixels
            check((1..<60).allSatisfy { ClawdMotion.frame(ClawdInput(state: state, beat: $0, reduceMotion: true)).pixels == first },
                  "still \(state)")
        }
        check(ClawdReaction.forTransition(from: .sleep, to: .walk) == .wake, "wake")
        check(ClawdReaction.forTransition(from: .sleep, to: .look) == .wake, "wake from look")
        check(ClawdReaction.forTransition(from: .walk, to: .sleep) == .startle, "startle")
        check(ClawdReaction.forTransition(from: .look, to: .walk) == .cheer, "cheer")
        check(ClawdReaction.forTransition(from: .idle, to: .walk) == nil, "no reaction")
        print(failures == 0 ? "Clawd checks passed" : "\(failures) Clawd checks failed")
        exit(failures == 0 ? 0 : 1)
    }
}
