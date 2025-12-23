import { Paper, Stack, Text, Title } from '@mantine/core';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';

export default function PlayerInfo() {
  const { state } = useCs2State();
  const player = state?.player || {};
  const map = state?.map || {};
  const team = player?.team || map?.team_ct?.name || '';

  return (
    <Paper
      shadow="xl"
      radius="md"
      p="md"
      withBorder
      style={{
        minWidth: 200,
        background: 'rgba(15, 15, 20, 0.74)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <Stack gap={2}>
        <Title order={3} c="white">
          {player?.name || '等待 CS2 GSI 数据...'}
        </Title>
        <Text size="sm" c="dimmed">
          {team || '未知阵营'}
        </Text>
      </Stack>
    </Paper>
  );
}

