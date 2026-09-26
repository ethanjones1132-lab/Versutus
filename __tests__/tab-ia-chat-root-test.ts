declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const readRootLand = () => readSource(['src', 'app', '(tabs)', 'index.tsx']);
const readHome = () => readSource(['src', 'app', '(tabs)', 'home.tsx']);
const readTabsLayout = () => readSource(['src', 'app', '(tabs)', '_layout.tsx']);
const readChatScreen = () => readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
const readTerminal = () => readSource(['src', 'components', 'terminal', 'terminal-screen.tsx']);
const readDrawerContent = () => readSource(['src', 'components', 'nav', 'side-drawer-content.tsx']);

/**
 * Contract test for the side-drawer IA (CHARTER / visual-direction LOCKED
 * 2026-09-24): Chat is the root land, NativeTabs are gone, the drawer holds
 * chats/Activity/Tools/settings + thin Gate status, and deep links to the
 * former tab destinations stay named. Home remains routable at `/home` but
 * is not a co-equal drawer pillar.
 */
describe('Side drawer IA — Chat root, zero bottom tabs', () => {
  test('the index route hands / to Chat instead of the old dashboard', () => {
    const src = readRootLand();
    expect(src).toContain("from 'expo-router'");
    expect(src).toContain('<Redirect');
    expect(src).toContain('href="/chat"');
    expect(src).not.toContain('GatewayHomeDashboard');
    expect(src).not.toContain('ScreenHeader');
  });

  test('the Home/Gate dashboard lives behind its own /home route', () => {
    const src = readHome();
    expect(src).toContain('export default function HomeScreen');
    expect(src).toContain('<GatewayHomeDashboard');
    expect(src).toContain('<ScreenHeader');
    expect(src).toContain('refreshError');
  });

  test('the (tabs) layout is a Drawer with zero NativeTabs', () => {
    const src = readTabsLayout();
    expect(src).toContain("from 'expo-router/drawer'");
    expect(src).toContain('<Drawer');
    expect(src).toContain('initialRouteName="chat"');
    expect(src).toContain('SideDrawerContent');
    expect(src).not.toContain('NativeTabs');
    expect(src).not.toContain('NativeTabs.Trigger');
  });

  test('drawer screens keep deep-link destinations for chat/activity/tools/home', () => {
    const src = readTabsLayout();
    for (const name of ['chat', 'activity', 'terminal', 'home']) {
      expect(src).toContain(`name="${name}"`);
    }
    // Home is routable but hidden from the default drawer item list.
    expect(src).toMatch(/name="home"[\s\S]*drawerItemStyle:\s*\{\s*display:\s*'none'/);
  });

  test('drawer content lists chats, Activity, Tools, settings, and Gate status', () => {
    const src = readDrawerContent();
    expect(src).toContain("href: '/chat'");
    expect(src).toContain("href: '/activity'");
    expect(src).toContain("href: '/terminal'");
    expect(src).toContain("href: '/gateway/settings'");
    expect(src).toContain("go('/home')");
    expect(src).toContain('GATE');
    expect(src).toContain('statusLabel(status)');
  });

  test('selected chrome never falls back to metallic gold', () => {
    const src = readTabsLayout();
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('#D4AF37');
    const drawer = readDrawerContent();
    expect(drawer).not.toContain('Palette.gold');
    expect(drawer).not.toContain('#D4AF37');
  });

  test('Go to Home targets the demoted /home route, not the root redirect', () => {
    expect(readChatScreen()).toContain("onGoHome={() => router.replace('/home')}");
    expect(readTerminal()).toContain("onGoHome={() => router.replace('/home')}");
    expect(readChatScreen()).not.toContain("router.replace('/')}");
    expect(readTerminal()).not.toContain("router.replace('/')}");
  });
});
