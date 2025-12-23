import { Group, Paper, Stack, Text } from '@mantine/core';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';

export default function Score() {
  const { state } = useCs2State();
  const map = state?.map || {};
  const tScore = map?.team_t?.score ?? 0;
  const ctScore = map?.team_ct?.score ?? 0;

  return (
    <Paper
      shadow="xl"
      radius="md"
      p="md"
      withBorder
      style={{
        minWidth: 180,
        background: 'rgba(15, 15, 20, 0.74)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <Stack gap={2} align="flex-end">
        <Text size="sm" c="dimmed">
          {map?.name || '未知地图'}
        </Text>
        <Group gap="xs">
          <Text size="sm" c="yellow">
            T {tScore}
          </Text>
          <Text size="sm" c="dimmed">
            :
          </Text>
          <Text size="sm" c="cyan">
            CT {ctScore}
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

