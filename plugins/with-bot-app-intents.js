const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const { getProjectName, addBuildSourceFileToGroup } = require('@expo/config-plugins/build/ios/utils/Xcodeproj');

const BRIDGE_FILE_NAME = 'VersutusShortcutsAppIntentsPackage.swift';
const BRIDGE_CONTENTS = `import AppIntents
import VersutusShortcuts

/// App-target bridge that makes the framework's App Intents discoverable
/// at build time (Apple only extracts intent metadata from the app target).
struct VersutusAppIntentsPackage: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] {
    [VersutusShortcutsAppIntentsPackage.self]
  }
}
`;

function withBotAppIntents(config) {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const platformProjectRoot = config.modRequest.platformProjectRoot;
      const projectName = getProjectName(projectRoot);
      const targetDirectory = path.join(platformProjectRoot, projectName);
      fs.mkdirSync(targetDirectory, { recursive: true });
      const filePath = path.join(targetDirectory, BRIDGE_FILE_NAME);
      fs.writeFileSync(filePath, BRIDGE_CONTENTS);
      return config;
    },
  ]);

  config = withXcodeProject(config, (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const projectName = getProjectName(projectRoot);
    const relativePath = path.join(projectName, BRIDGE_FILE_NAME);
    if (config.modResults.hasFile(relativePath)) {
      return config;
    }
    // `addSourceFile` semantics are handled by Expo's build-source-file helper,
    // which compiles this bridge into the app target where Apple extracts App
    // Intent metadata.
    config.modResults = addBuildSourceFileToGroup({
      filepath: relativePath,
      groupName: projectName,
      project: config.modResults,
      verbose: true,
    });
    return config;
  });

  return config;
}

module.exports = withBotAppIntents;
