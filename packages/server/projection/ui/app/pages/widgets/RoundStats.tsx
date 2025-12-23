import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import React, { useEffect, useState } from 'react';
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

export default function RoundStats() {
  const { state } = useCs2State();
  const player = state?.player || {};
  const round = state?.round || {};
  const playerState = player?.state || {};
  const [shouldShow, setShouldShow] = useState(false);
  const [lastRoundNumber, setLastRoundNumber] = useState<number | null>(null);

  const roundKills = playerState.round_kills ?? 0;
  const roundKillhs = playerState.round_killhs ?? 0; // 爆头击杀
  const roundDamage = playerState.round_damage ?? 0;
  const roundPhase = round?.phase || '';
  const currentRoundNumber = round?.round ?? null;

  // 检测回合状态变化
  useEffect(() => {
    // 检测回合结束：phase 变成 'over' 或 'gameover'
    if (roundPhase === 'over' || roundPhase === 'gameover') {
      setShouldShow(true);
    }

    // 检测新回合开始：round 数字变化，或者 phase 变成 'live' / 'warmup'
    if (currentRoundNumber !== null) {
      if (lastRoundNumber !== null && currentRoundNumber !== lastRoundNumber) {
        // 回合数变化，说明新回合开始了
        setShouldShow(false);
      }
      setLastRoundNumber(currentRoundNumber);
    }

    // 如果 phase 变成 'live' 或 'warmup'，说明新回合开始，隐藏
    if (roundPhase === 'live' || roundPhase === 'warmup') {
      // 只有在之前显示过的情况下才隐藏（避免初始化时误判）
      if (shouldShow) {
        setShouldShow(false);
      }
    }
  }, [roundPhase, currentRoundNumber, lastRoundNumber, shouldShow]);

  // 如果不需要显示，完全不渲染
  if (!shouldShow) {
    return null;
  }

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
          本回合数据
        </Title>
        <StatItem label="击杀" value={roundKills} color="green" />
        <StatItem label="爆头击杀" value={roundKillhs} color="orange" />
        <StatItem label="伤害" value={roundDamage} color="red" />
      </Stack>
    </Paper>
  );
}

