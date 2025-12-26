import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCs2State } from '../../hooks/useCs2State';
import { useEventSystem } from '../../hooks/useEventSystem';
import { WidgetConfig } from '../../utils/widgetConfig';

function StatItem({ label, value, color = 'white' }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <Group justify="space-between" gap="md">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={700} c={color}>
        {value}
      </Text>
    </Group>
  );
}

interface PlayerStatsProps {
  config?: WidgetConfig;
}

export default function PlayerStats({ config }: PlayerStatsProps) {
  // 使用事件系统控制可见性
  const { isVisible } = useEventSystem('stats', true, false);
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const { state } = useCs2State();
  const player = state?.player || {};
  const matchStats = player?.match_stats || {};

  const kills = matchStats.kills ?? 0;
  const deaths = matchStats.deaths ?? 0;
  const assists = matchStats.assists ?? 0;
  const mvps = matchStats.mvps ?? 0;
  const score = matchStats.score ?? 0;

  // 计算 K/D 比
  const kdRatio = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? kills.toFixed(2) : '0.00';

  const style = config?.style || {};

  if (!isVisible && !isPreview) {
    return null;
  }

  return (
    <Paper
      shadow={style.shadow || 'xl'}
      radius={style.borderRadius || 'md'}
      p={style.padding || 'md'}
      withBorder
      style={{
        minWidth: style.minWidth || 280,
        background: style.background || 'rgba(15, 15, 20, 0.74)',
        borderColor: style.borderColor || 'rgba(255, 255, 255, 0.12)',
        backdropFilter: style.backdropFilter || 'blur(12px)',
        border: style.border,
      }}
    >
      <Stack gap="sm">
        <Title order={4} c="white" mb="xs">
          玩家统计
        </Title>
        <StatItem label="击杀" value={isPreview ? 15 : kills} color="green" />
        <StatItem label="死亡" value={isPreview ? 8 : deaths} color="red" />
        <StatItem label="助攻" value={isPreview ? 5 : assists} color="blue" />
        <StatItem label="K/D" value={isPreview ? '1.88' : kdRatio} color="yellow" />
        <StatItem label="MVP" value={isPreview ? 2 : mvps} color="orange" />
        <StatItem label="得分" value={isPreview ? 1250 : score} color="cyan" />
      </Stack>
    </Paper>
  );
}

