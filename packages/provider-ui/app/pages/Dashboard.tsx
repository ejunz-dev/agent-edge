import {
  Group, Paper, SimpleGrid, Text,
} from '@mantine/core';
import {
  IconApi, IconChecklist, IconTool,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import React from 'react';

export function StatsCard({ title, value, Icon }) {
  return (
    <Paper withBorder p="md" radius="md" key={title}>
      <Group justify="space-between">
        <Text size="md" c="dimmed">
          {title}
        </Text>
        <Icon size="2rem" stroke={1.5} />
      </Group>

      <Group align="flex-end" gap="xs" mt={25}>
        <Text size="xl" fw={700}>
          {value}
        </Text>
      </Group>
    </Paper>
  );
}

export default function Dashboard() {
  const { data: toolsData } = useQuery({
    queryKey: ['provider_tools'],
    queryFn: () => fetch('/api/tools').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const { data: configData } = useQuery({
    queryKey: ['provider_config'],
    queryFn: () => fetch('/api/config').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const toolCount = toolsData?.tools?.length || 0;
  const enabledTools = toolsData?.tools?.filter((t: any) => t.enabled).length || 0;
  const disabledTools = toolCount - enabledTools;
  const wsEnabled = configData?.ws?.enabled !== false;

  return (
    <div>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} m="lg">
        <StatsCard title="工具总数" value={toolCount} Icon={IconTool} />
        <StatsCard title="已启用工具" value={enabledTools} Icon={IconChecklist} />
        <StatsCard title="已禁用工具" value={disabledTools} Icon={IconApi} />
        <StatsCard title="WebSocket状态" value={wsEnabled ? '已启用' : '已禁用'} Icon={IconApi} />
      </SimpleGrid>
    </div>
  );
}

