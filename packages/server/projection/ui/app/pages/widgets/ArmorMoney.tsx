import { Box, Group, Paper, Progress, Text, ThemeIcon } from '@mantine/core';
import { IconShield } from '@tabler/icons-react';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';

export default function ArmorMoney() {
  const { state } = useCs2State();
  const player = state?.player || {};
  const armor = Number(player?.state?.armor ?? 0);
  const money = Number(player?.state?.money ?? 0);

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
      <Group gap="md">
        <Box flex={1}>
          <Group gap="xs" mb={4}>
            <ThemeIcon variant="light" radius="xl" color="blue" size="sm">
              <IconShield size={14} />
            </ThemeIcon>
            <Text size="xs" c="blue.2" tt="uppercase">
              Armor {armor}
            </Text>
          </Group>
          <Progress
            value={Math.max(0, Math.min(100, armor))}
            color="blue"
            size="sm"
            radius="xl"
          />
        </Box>
        <Box>
          <Text size="xs" c="yellow.3">
            $ {money}
          </Text>
        </Box>
      </Group>
    </Paper>
  );
}

