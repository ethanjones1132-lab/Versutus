import AppIntents
import Foundation
import UIKit

/// An AppEntity backed by the locally stored recent Bot ids. The query reads
/// those ids straight from UserDefaults written by the Expo module, so Siri
/// and the Shortcuts app always reflect the same recents as the app.
public struct BotEntity: AppEntity {
    public static let typeDisplayRepresentation: TypeDisplayRepresentation =
        TypeDisplayRepresentation(name: "Bot")

    public static let defaultQuery = BotEntityQuery()

    public var id: String

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(id)")
    }

    public init(id: String) {
        self.id = id
    }
}

public struct BotEntityQuery: EntityQuery {
    private static let defaultsKey = "versutus.recentBotIds"

    private static func recentIds() -> [String] {
        let raw = UserDefaults.standard.array(forKey: defaultsKey) as? [String] ?? []
        var seen = Set<String>()
        var result: [String] = []
        for entry in raw {
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || seen.contains(trimmed) { continue }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    public func entities(for identifiers: [String]) async throws -> [BotEntity] {
        let stored = Self.recentIds()
        return identifiers.compactMap { identifier in
            stored.contains(identifier) ? BotEntity(id: identifier) : nil
        }
    }

    public func suggestedEntities() async throws -> [BotEntity] {
        Self.recentIds().map { BotEntity(id: $0) }
    }
}

/// Opens the Bot Chat route already answered by `versutus://chat?bot=<id>`,
/// with the composer focused by that route's existing handling.
public struct TalkToBotIntent: AppIntent {
    public static let title: LocalizedStringResource = "Talk to Bot"

    public static let description = IntentDescription(
        "Open the chat with a recent Bot, with the composer focused."
    )

    public static let openAppWhenRun: Bool = true

    @Parameter(title: "Bot")
    public var bot: BotEntity

    public init() {}

    public init(bot: BotEntity) {
        self.bot = bot
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        let encoded = bot.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? bot.id
        guard let url = URL(string: "versutus://chat?bot=\(encoded)") else {
            return .result()
        }
        UIApplication.shared.open(url)
        return .result()
    }
}

/// Provides the spoken Shortcuts phrases. The parameterized phrase expands to
/// one shortcut per suggested Bot, refreshed via `updateAppShortcutParameters`.
public struct VersutusBotAppShortcutsProvider: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToBotIntent(),
            phrases: [
                "Talk to \(\.$bot) in \(.applicationName)",
                "Chat with \(\.$bot) in \(.applicationName)"
            ],
            shortTitle: "Talk to Bot",
            systemImageName: "bubble.left"
        )
    }
}

/// Declares the Expo module's App Intents so the app target can include them.
public struct VersutusShortcutsAppIntentsPackage: AppIntentsPackage {}
