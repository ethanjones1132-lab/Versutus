import AppIntents
import ExpoModulesCore
import Foundation

public class VersutusShortcutsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VersutusShortcuts")

    AsyncFunction("setShortcuts") { (shortcuts: [[String: Any]]) in
      self.persistRecentBotIds(from: shortcuts)
      self.refreshAppShortcutParameters()
      return true
    }

    AsyncFunction("updateShortcuts") { (shortcuts: [[String: Any]]) in
      self.persistRecentBotIds(from: shortcuts)
      self.refreshAppShortcutParameters()
      return true
    }

    AsyncFunction("donateShortcuts") { (shortcuts: [[String: Any]]) in
      self.persistRecentBotIds(from: shortcuts)
      self.refreshAppShortcutParameters()
      return true
    }

    AsyncFunction("setDynamicShortcuts") { (shortcuts: [[String: Any]]) in
      self.persistRecentBotIds(from: shortcuts)
      self.refreshAppShortcutParameters()
      return true
    }
  }

  private static let defaultsKey = "versutus.recentBotIds"

  private func persistRecentBotIds(from shortcuts: [[String: Any]]) {
    var ids: [String] = []
    var seen = Set<String>()
    for shortcut in shortcuts {
      guard let id = recentBotId(from: shortcut) else { continue }
      if seen.contains(id) { continue }
      seen.insert(id)
      ids.append(id)
    }
    UserDefaults.standard.set(ids, forKey: Self.defaultsKey)
  }

  private func recentBotId(from shortcut: [String: Any]) -> String? {
    if let url = shortcut["url"] as? String,
       let components = URLComponents(string: url),
       let value = components.queryItems?.first(where: { $0.name == "bot" })?.value {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { return trimmed }
    }
    if let id = shortcut["id"] as? String {
      let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.hasPrefix("bot-") {
        let candidate = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
        if !candidate.isEmpty { return candidate }
      }
    }
    return nil
  }

  private func refreshAppShortcutParameters() {
    Task {
      try? await VersutusBotAppShortcutsProvider.updateAppShortcutParameters()
    }
  }
}
