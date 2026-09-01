//
//  Desk Log — menu bar companion
//
//  Friction is what makes people forget to record a posture change, and a
//  browser tab you have to go and find is friction. This puts the current
//  posture and its elapsed time in the menu bar, and a switch one click away.
//
//  It owns no data. Everything goes through the tracker's HTTP API, so this
//  and the web page can be open at once and agree with each other.
//

import AppKit
import Foundation

// MARK: - Talking to the tracker

struct Session {
    let id: Int
    let posture: String
    let startedAt: Double
}

struct TrackerState {
    let session: Session?
    let serverNow: Double
    let standMs: Double
    let goalMs: Double
    let withinWorkHours: Bool
}

enum TrackerError: Error { case unreachable }

final class Tracker {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        self.session = URLSession(configuration: configuration)
    }

    func fetchState(completion: @escaping (Result<TrackerState, Error>) -> Void) {
        let task = session.dataTask(with: baseURL.appendingPathComponent("api/state")) { data, _, error in
            guard
                let data = data, error == nil,
                let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let payload = root["data"] as? [String: Any],
                let now = payload["now"] as? Double
            else {
                completion(.failure(error ?? TrackerError.unreachable))
                return
            }

            completion(.success(Tracker.readState(payload, now: now)))
        }
        task.resume()
    }

    /// The shape every state-bearing response comes back in.
    static func readState(_ payload: [String: Any], now: Double) -> TrackerState {
        var current: Session?
        if let raw = payload["session"] as? [String: Any],
           let id = raw["id"] as? Int,
           let posture = raw["posture"] as? String,
           let startedAt = raw["started_at"] as? Double {
            current = Session(id: id, posture: posture, startedAt: startedAt)
        }

        let goal = payload["goal"] as? [String: Any]
        return TrackerState(
            session: current,
            serverNow: now,
            standMs: goal?["standMs"] as? Double ?? 0,
            goalMs: goal?["goalMs"] as? Double ?? 0,
            withinWorkHours: payload["withinWorkHours"] as? Bool ?? false
        )
    }

    /// Post a posture, or stop tracking altogether.
    ///
    /// `at` says when the switch really happened, which matters when the Mac is
    /// on its way to sleep and we are reporting the moment rather than the
    /// moment of the request.
    func send(posture: String?, at: Double? = nil, completion: @escaping (TrackerState?) -> Void) {
        let path = posture == nil ? "api/stop" : "api/toggle"
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        var body: [String: Any] = [:]
        if let posture = posture { body["posture"] = posture }
        if let at = at { body["at"] = at }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        session.dataTask(with: request) { data, _, _ in
            guard
                let data = data,
                let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let payload = root["data"] as? [String: Any],
                let now = payload["now"] as? Double
            else {
                completion(nil)
                return
            }
            completion(Tracker.readState(payload, now: now))
        }.resume()
    }

    /// Remove a recorded block outright.
    func delete(sessionId: Int, completion: @escaping () -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/sessions/\(sessionId)"))
        request.httpMethod = "DELETE"
        session.dataTask(with: request) { _, _, _ in completion() }.resume()
    }
}

// MARK: - Presentation

enum Posture: String {
    case sit, stand, away

    var name: String {
        switch self {
        case .sit: return "Sitting"
        case .stand: return "Standing"
        case .away: return "Away from desk"
        }
    }

    /// A glyph that survives being 14 points tall in a menu bar.
    var symbolName: String {
        switch self {
        case .sit: return "figure.seated.side"
        case .stand: return "figure.stand"
        case .away: return "figure.walk"
        }
    }

    var fallbackGlyph: String {
        switch self {
        case .sit: return "S"
        case .stand: return "T"
        case .away: return "A"
        }
    }
}

func formatElapsed(_ ms: Double) -> String {
    let minutes = max(0, Int(ms / 60_000))
    if minutes < 60 { return "\(minutes)m" }
    let rest = minutes % 60
    return rest == 0 ? "\(minutes / 60)h" : "\(minutes / 60)h \(rest)m"
}

// MARK: - The app

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let tracker: Tracker
    private let dashboardURL: URL

    private var state: TrackerState?
    private var reachable = true
    /// Server time minus our time, so elapsed matches what the page shows.
    private var clockOffset: Double = 0

    private var pollTimer: Timer?
    private var tickTimer: Timer?

    /// What we interrupted when the Mac went away, so it can be put back - or
    /// removed entirely if the working day ended while the Mac was asleep.
    private var interrupted: (sessionId: Int, resume: String, at: Date)?

    init(baseURL: URL) {
        self.tracker = Tracker(baseURL: baseURL)
        self.dashboardURL = baseURL
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.menu = NSMenu()
        statusItem.menu?.delegate = self

        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(stepAway),
                              name: NSWorkspace.willSleepNotification, object: nil)
        workspace.addObserver(self, selector: #selector(comeBack),
                              name: NSWorkspace.didWakeNotification, object: nil)

        let distributed = DistributedNotificationCenter.default()
        distributed.addObserver(self, selector: #selector(stepAway),
                                name: .init("com.apple.screenIsLocked"), object: nil)
        distributed.addObserver(self, selector: #selector(comeBack),
                                name: .init("com.apple.screenIsUnlocked"), object: nil)

        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.updateTitle()
        }
    }

    private func refresh() {
        tracker.fetchState { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch result {
                case .success(let state):
                    self.state = state
                    self.clockOffset = state.serverNow - Date().timeIntervalSince1970 * 1000
                    self.reachable = true
                case .failure:
                    self.reachable = false
                }
                self.updateTitle()
            }
        }
    }

    private var serverNow: Double { Date().timeIntervalSince1970 * 1000 + clockOffset }

    private func updateTitle() {
        guard let button = statusItem.button else { return }

        guard reachable else {
            button.image = nil
            button.title = "Desk ·"
            button.toolTip = "The desk log is not running"
            return
        }

        guard let session = state?.session, let posture = Posture(rawValue: session.posture) else {
            button.image = nil
            button.title = "Desk"
            button.toolTip = "Nothing being tracked"
            return
        }

        let elapsed = formatElapsed(serverNow - session.startedAt)
        if let image = NSImage(systemSymbolName: posture.symbolName, accessibilityDescription: posture.name) {
            image.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeading
            button.title = " \(elapsed)"
        } else {
            button.image = nil
            button.title = "\(posture.fallbackGlyph) \(elapsed)"
        }
        button.toolTip = "\(posture.name) for \(elapsed)"
    }

    // MARK: Leaving and returning

    /// The Mac is sleeping or locking. Record the absence from this moment,
    /// not from whenever we next get a chance to speak to the tracker.
    ///
    /// Sleep is on its way, so this waits for the request rather than letting
    /// the process be suspended mid-flight. macOS allows a short pause here.
    @objc private func stepAway() {
        guard interrupted == nil, let state = state, state.withinWorkHours,
              let session = state.session,
              session.posture == "sit" || session.posture == "stand"
        else { return }

        let leftAt = Date()
        let waited = DispatchSemaphore(value: 0)
        var opened: Session?

        tracker.send(posture: "away", at: leftAt.timeIntervalSince1970 * 1000) { newState in
            opened = newState?.session
            waited.signal()
        }
        _ = waited.wait(timeout: .now() + 3)

        if let away = opened, away.posture == "away" {
            interrupted = (sessionId: away.id, resume: session.posture, at: leftAt)
        }
    }

    /// Back at the desk. Pick the posture up again if the same working day is
    /// still running; otherwise the day ended while the Mac was away, so take
    /// the absence back out and let the day finish where it stopped.
    @objc private func comeBack() {
        guard let context = interrupted else {
            refresh()
            return
        }
        interrupted = nil

        let returnedAt = Date()
        tracker.fetchState { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, case .success(let state) = result else { return }

                let sameDay = Calendar.current.isDate(returnedAt, inSameDayAs: context.at)
                if sameDay && state.withinWorkHours {
                    self.tracker.send(posture: context.resume,
                                      at: returnedAt.timeIntervalSince1970 * 1000) { _ in
                        DispatchQueue.main.async { self.refresh() }
                    }
                } else {
                    self.tracker.delete(sessionId: context.sessionId) {
                        DispatchQueue.main.async { self.refresh() }
                    }
                }
            }
        }
    }

    // MARK: Menu

    private func populate(_ menu: NSMenu) {
        menu.removeAllItems()

        if !reachable {
            menu.addItem(disabled("The tracker is not running"))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(action("Open dashboard", #selector(openDashboard)))
            menu.addItem(action("Quit", #selector(quit)))
            return
        }

        let current = state?.session.flatMap { Posture(rawValue: $0.posture) }
        if let session = state?.session, let posture = current {
            menu.addItem(disabled("\(posture.name) for \(formatElapsed(serverNow - session.startedAt))"))
        } else {
            menu.addItem(disabled("Nothing being tracked"))
        }

        if let state = state, state.goalMs > 0 {
            let remaining = max(0, state.goalMs - state.standMs)
            menu.addItem(disabled(
                remaining == 0
                    ? "Standing goal met"
                    : "\(formatElapsed(remaining)) left on the standing goal"
            ))
        }

        menu.addItem(NSMenuItem.separator())

        // Only offer the postures you are not already in.
        for posture in [Posture.sit, .stand, .away] where posture != current {
            let title: String
            switch posture {
            case .sit: title = current == nil ? "Start sitting" : "Sit down"
            case .stand: title = current == nil ? "Start standing" : "Stand up"
            case .away: title = "Away from desk"
            }
            let item = action(title, #selector(switchPosture(_:)))
            item.representedObject = posture.rawValue
            menu.addItem(item)
        }

        if state?.session != nil {
            menu.addItem(action("Stop tracking", #selector(stopTracking)))
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(action("Open dashboard", #selector(openDashboard)))
        menu.addItem(action("Quit", #selector(quit)))
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func switchPosture(_ sender: NSMenuItem) {
        guard let posture = sender.representedObject as? String else { return }
        tracker.send(posture: posture) { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }
    }

    @objc private func stopTracking() {
        tracker.send(posture: nil) { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }
    }

    @objc private func openDashboard() { NSWorkspace.shared.open(dashboardURL) }

    @objc private func quit() { NSApplication.shared.terminate(nil) }
}

extension AppDelegate: NSMenuDelegate {
    /// Rebuilt every time it opens, so it always reflects the current posture.
    func menuNeedsUpdate(_ menu: NSMenu) {
        populate(menu)
    }
}

// MARK: - Entry point

let urlString = ProcessInfo.processInfo.environment["DESK_LOG_URL"] ?? "http://127.0.0.1:4321"
guard let baseURL = URL(string: urlString) else {
    FileHandle.standardError.write(Data("DESK_LOG_URL is not a URL: \(urlString)\n".utf8))
    exit(1)
}

// One-shot mode: `DeskLog --posture stand` records a switch and exits, which
// makes the app usable from a keyboard shortcut or a launcher as well as from
// the menu bar. `--posture stop` ends tracking.
let arguments = CommandLine.arguments
if let flag = arguments.firstIndex(of: "--posture") {
    guard flag + 1 < arguments.count else {
        FileHandle.standardError.write(Data("--posture needs sit, stand, away or stop\n".utf8))
        exit(2)
    }
    let requested = arguments[flag + 1]
    guard requested == "stop" || Posture(rawValue: requested) != nil else {
        FileHandle.standardError.write(Data("Unknown posture \(requested)\n".utf8))
        exit(2)
    }

    let finished = DispatchSemaphore(value: 0)
    Tracker(baseURL: baseURL).send(posture: requested == "stop" ? nil : requested) { _ in
        finished.signal()
    }
    exit(finished.wait(timeout: .now() + 6) == .success ? 0 : 1)
}

let application = NSApplication.shared
let delegate = AppDelegate(baseURL: baseURL)
application.delegate = delegate
application.setActivationPolicy(.accessory)   // menu bar only, no dock icon
application.run()
