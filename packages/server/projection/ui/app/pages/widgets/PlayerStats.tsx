import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';

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

export default function PlayerStats() {
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

  return (
    <Paper
      shadow="xl"
      radius="md"
      p="md"
      withBorder
      style={{
        minWidth: 280,
        background: 'rgba(15, 15, 20, 0.74)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <Stack gap="sm">
        <Title order={4} c="white" mb="xs">
          玩家统计
        </Title>
        <StatItem label="击杀" value={kills} color="green" />
        <StatItem label="死亡" value={deaths} color="red" />
        <StatItem label="助攻" value={assists} color="blue" />
        <StatItem label="K/D" value={kdRatio} color="yellow" />
        <StatItem label="MVP" value={mvps} color="orange" />
        <StatItem label="得分" value={score} color="cyan" />
      </Stack>
    </Paper>
  );
}

