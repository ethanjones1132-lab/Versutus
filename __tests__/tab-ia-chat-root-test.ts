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

/**
 * Contract test for the tab IA pass (CHARTER priority 3, visual-direction
 * 2026-09): Chat is the root land and the hero (first) trigger, Home is
 * demoted to the trailing slot on its own /home route, all four tabs stay
 * reachable, and selected chrome is violet — never gold. Deep links keep
 * naming /chat; "Go to Home" now points at the demoted route so it cannot
 * bounce through the root redirect into Chat.
 */
describe('Chat is the root land; Home is a demoted trailing tab', () => {
  test('the index route hands / to Chat instead of the old dashboard', () => {
    const src = readRootLand();
    expect(src).toContain("from 'expo-router'");
    expect(src).toContain('<Redirect');
    expect(src).toContain('href="/chat"');
    expect(src).not.toContain('GatewayHomeDashboard');
    expect(src).not.toContain('ScreenHeader');
  });

  test('the Home dashboard lives behind its own /home route', () => {
    const src = readHome();
    expect(src).toContain('export default function HomeScreen');
    expect(src).toContain('<GatewayHomeDashboard');
    expect(src).toContain('<ScreenHeader');
    expect(src).toContain('refreshError');
  });

  test('Chat is the first trigger; Home is demoted to the last', () => {
    const src = readTabsLayout();
    const chat = src.indexOf('<NativeTabs.Trigger name="chat">');
    const activity = src.indexOf('<NativeTabs.Trigger name="activity">');
    const terminal = src.indexOf('<NativeTabs.Trigger name="terminal">');
    const home = src.indexOf('<NativeTabs.Trigger name="home">');
    expect(chat).toBeGreaterThanOrEqual(0);
    expect(activity).toBeGreaterThan(chat);
    expect(terminal).toBeGreaterThan(activity);
    expect(home).toBeGreaterThan(terminal);
    // The root redirect is not a tab of its own — no phantom fifth pillar.
    expect(src).not.toContain('<NativeTabs.Trigger name="index">');
    // Home's old equal-pillar seat at the head of the bar is gone.
    expect(src.indexOf('<NativeTabs.Trigger name="home">')).not.toBe(0);
  });

  test('all four destinations remain reachable tabs', () => {
    const src = readTabsLayout();
    for (const name of ['chat', 'activity', 'terminal', 'home']) {
      expect(src).toContain(`<NativeTabs.Trigger name="${name}">`);
      expect(src).toContain(`name="${name}"`);
    }
    expect(src).toContain('<NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>');
    expect(src).toContain('<NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>');
  });

  test('selected tab chrome is violet brand, never metallic gold', () => {
    const src = readTabsLayout();
    expect(src).toContain('selected: Palette.accentWarm');
    expect(src).toContain('tintColor={Palette.accentWarm}');
    expect(src).toContain('indicatorColor={Palette.accentMuted}');
    expect(src).not.toContain('Palette.gold');
    expect(src).not.toContain('#D4AF37');
    expect(src).not.toContain('Palette.accentWarmMuted');
  });

  test('Go to Home targets the demoted /home route, not the root redirect', () => {
    expect(readChatScreen()).toContain("onGoHome={() => router.replace('/home')}");
    expect(readTerminal()).toContain("onGoHome={() => router.replace('/home')}");
    expect(readChatScreen()).not.toContain("router.replace('/')}");
    expect(readTerminal()).not.toContain("router.replace('/')}");
  });
});
