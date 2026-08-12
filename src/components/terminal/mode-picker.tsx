import { TERMINAL_MODES, type TerminalMode } from '@/components/terminal/terminal-modes';
import { SegmentedControl } from '@/components/ui';

export type { TerminalMode } from '@/components/terminal/terminal-modes';

export function TerminalModePicker({
  mode,
  onModeChange,
}: {
  mode: TerminalMode;
  onModeChange: (mode: TerminalMode) => void;
}) {
  return (
    <SegmentedControl
      options={TERMINAL_MODES.map((item) => ({ key: item.id, label: item.label }))}
      selectedKey={mode}
      onSelect={onModeChange}
    />
  );
}
