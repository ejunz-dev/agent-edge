import { Box, Group, Paper, Progress, Text, ThemeIcon } from '@mantine/core';
import { IconSword } from '@tabler/icons-react';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';

export default function HealthBar() {
  const { state } = useCs2State();
  const player = state?.player || {};
  const hp = Number(player?.state?.health ?? 0);

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
      <Box>
        <Group gap="xs" mb={4}>
          <ThemeIcon variant="light" radius="xl" color="red" size="sm">
            <IconSword size={14} />
          </ThemeIcon>
          <Text size="xs" c="red.2" tt="uppercase">
            HP {hp}
          </Text>
        </Group>
        <Progress value={Math.max(0, Math.min(100, hp))} color="red" size="lg" radius="xl" />
      </Box>
    </Paper>
  );
}

