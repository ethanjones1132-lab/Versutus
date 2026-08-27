/**
 * Android edge-to-edge / navigation-bar contract.
 *
 * ComposerKeyboardLift opts into isNavigationBarTranslucentAndroid:true and
 * does keyboardHeight - insetBottom. On Android 15+ edge-to-edge is mandatory,
 * so the insets.bottom is the gesture/3-button bar and the subtraction is correct
 * only if the manifest actually declares a translucent window and the config
 * documents the expected bar style / soft-input mode. This pin keeps app.json
 * and the lift in sync.
 */
declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readAppJson(): {
  expo: {
    android?: {
      edgeToEdgeEnabled?: boolean;
      softwareKeyboardLayoutMode?: string;
      navigationBar?: { backgroundColor?: string; barStyle?: string };
      androidNavigationBar?: Record<string, unknown>;
    };
  };
} {
  return JSON.parse(
    nodeFs.readFileSync([__dirname, '..', 'app.json'].join(SEP), 'utf8'),
  ) as {
    expo: {
      android?: {
        edgeToEdgeEnabled?: boolean;
        softwareKeyboardLayoutMode?: string;
        navigationBar?: { backgroundColor?: string; barStyle?: string };
        androidNavigationBar?: Record<string, unknown>;
      };
    };
  };
}

describe('android edge-to-edge / navigationBar handling', () => {
  const appJson = readAppJson();
  const android = appJson.expo.android;

  test('android block exists', () => {
    expect(android).toBeDefined();
  });

  test('declares navigationBar or edgeToEdgeEnabled so translucent nav-bar assumption is explicit', () => {
    const hasNavBar = !!(android?.navigationBar || android?.androidNavigationBar);
    const hasEdgeToEdge = android?.edgeToEdgeEnabled !== undefined;
    // Expo 57: edge-to-edge is mandatory (Android 16), so navigationBar documents the
    // translucent handling that ComposerKeyboardLift relies on (isNavigationBarTranslucentAndroid:true).
    // Older SDKs used edgeToEdgeEnabled; either satisfies the intent.
    expect(hasNavBar || hasEdgeToEdge).toBe(true);
  });

  test('navigationBar documents the translucent bar color (dark UI)', () => {
    if (android?.navigationBar) {
      expect(android.navigationBar.backgroundColor).toBeDefined();
      expect(android.navigationBar.barStyle).toBeDefined();
    } else if (android?.androidNavigationBar) {
      expect(android.androidNavigationBar).toBeDefined();
    } else {
      // fallback: edgeToEdgeEnabled must be present
      expect(android?.edgeToEdgeEnabled).toBeDefined();
    }
  });

  test('softwareKeyboardLayoutMode is resize so insets.bottom subtraction is valid', () => {
    // src/lib/motion/keyboard-lift.ts does keyboardHeight - insetBottom;
    // that is correct only when windowSoftInputMode is resize (the default, now explicit).
    expect(android?.softwareKeyboardLayoutMode).toBe('resize');
  });

  test('ComposerKeyboardLift opts into translucent bars consistently with app.json', () => {
    const liftSource = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'components', 'layout', 'ComposerKeyboardLift.tsx'].join(SEP),
      'utf8',
    );
    expect(liftSource).toContain('isNavigationBarTranslucentAndroid: true');
    expect(liftSource).toContain('isStatusBarTranslucentAndroid: true');
    const keyboardLiftSource = nodeFs.readFileSync(
      [__dirname, '..', 'src', 'lib', 'motion', 'keyboard-lift.ts'].join(SEP),
      'utf8',
    );
    expect(keyboardLiftSource).toContain('keyboardHeight - inset');
  });
});
