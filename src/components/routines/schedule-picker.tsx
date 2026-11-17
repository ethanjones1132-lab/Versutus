import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Chip, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  scheduleDraftFromCron,
  scheduleDraftToCron,
  schedulePreview,
  type SchedulePreset,
} from '@/lib/routines/schedule';

const PRESETS: { id: SchedulePreset; label: string }[] = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Every week' },
  { id: 'every-hours', label: 'Every N hours' },
  { id: 'advanced', label: 'Advanced' },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function SchedulePicker({
  value,
  onChange,
  hour12 = false,
  disabled = false,
}: {
  value: string;
  onChange: (cron: string) => void;
  hour12?: boolean;
  disabled?: boolean;
}) {
  const parsed = scheduleDraftFromCron(value);
  const [mode, setMode] = useState<{ value: string; preset: SchedulePreset } | null>(null);
  const activePreset = mode?.value === value ? mode.preset : parsed.preset;
  const draft = { ...parsed, preset: activePreset };
  const update = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    const cron = scheduleDraftToCron(next);
    setMode({ value: cron, preset: next.preset });
    onChange(cron);
  };
  const preview = useMemo(() => schedulePreview(value, new Date(), hour12), [value, hour12]);
  const time = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;

  return (
    <View style={styles.root}>
      <Text variant="micro" color="secondary">WHEN</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {PRESETS.map((item) => (
          <Chip
            key={item.id}
            label={item.label}
            selected={activePreset === item.id}
            disabled={disabled}
            onPress={() => update({ preset: item.id })}
          />
        ))}
      </ScrollView>
      {activePreset === 'daily' || activePreset === 'weekdays' || activePreset === 'weekly' ? (
        <>
          {activePreset === 'weekly' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {DAYS.map((day, index) => (
                <Chip key={day} label={day} selected={parsed.weekday === index} disabled={disabled} onPress={() => update({ weekday: index })} />
              ))}
            </ScrollView>
          ) : null}
          <TextField
            value={time}
            onChangeText={(input) => {
              const match = /^(\d{1,2}):(\d{0,2})$/.exec(input);
              if (!match) return;
              const hour = Number(match[1]);
              const minute = match[2] === '' ? 0 : Number(match[2]);
              if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) update({ hour, minute });
            }}
            placeholder="09:00"
            accessibilityLabel="Schedule time in 24-hour format"
            autoCapitalize="none"
            editable={!disabled}
          />
        </>
      ) : null}
      {activePreset === 'every-hours' ? (
        <View style={styles.interval}>
          <TextField
            value={String(parsed.intervalHours)}
            onChangeText={(input) => {
              if (!/^\d{0,2}$/.test(input)) return;
              const intervalHours = Number(input);
              if (intervalHours >= 1 && intervalHours <= 24) update({ intervalHours });
            }}
            placeholder="2"
            accessibilityLabel="Hours between runs"
            editable={!disabled}
          />
          <Text variant="caption" color="secondary">hours</Text>
        </View>
      ) : null}
      {activePreset === 'advanced' ? (
        <TextField
          value={value}
          onChangeText={(cron) => {
            setMode({ value: cron, preset: 'advanced' });
            onChange(cron);
          }}
          placeholder="0 9 * * 1-5"
          accessibilityLabel="Advanced five-field cron schedule"
          autoCapitalize="none"
          editable={!disabled}
        />
      ) : null}
      <Text variant="caption" color="secondary">{preview.description}</Text>
      <Text variant="micro" color="tertiary">{`Next run: ${preview.nextRun}`}</Text>
      {activePreset === 'advanced' ? (
        <Button label="Use a preset" variant="ghost" size="sm" disabled={disabled} onPress={() => update({ preset: 'daily' })} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: Spacing.two },
  chips: { gap: Spacing.two, alignItems: 'center' },
  interval: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
