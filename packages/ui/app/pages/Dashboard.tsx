import {
  Group, Paper, SimpleGrid, Text,
} from '@mantine/core';
import {
  IconApi, IconApiApp, IconChecklist, IconTool,
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
  const { data: serversData } = useQuery({
    queryKey: ['mcp_servers'],
    queryFn: () => fetch('/mcp/servers').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const { data: toolsData } = useQuery({
    queryKey: ['mcp_tools'],
    queryFn: () => fetch('/mcp/tools').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const serverCount = serversData?.servers?.length || 0;
  const onlineServers = serversData?.servers?.filter((s: any) => s.status === 'online').length || 0;
  const offlineServers = serverCount - onlineServers;
  const toolCount = toolsData?.tools?.length || 0;
  const totalCalls = serversData?.servers?.reduce((sum: number, s: any) => sum + (s.totalCalls || 0), 0) || 0;
  const totalTools = serversData?.servers?.reduce((sum: number, s: any) => sum + (s.toolCount || 0), 0) || 0;

  return (
    <div>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} m="lg">
        <StatsCard title="MCP 服务器 (在线)" value={onlineServers} Icon={IconApi} />
        <StatsCard title="MCP 服务器 (离线)" value={offlineServers} Icon={IconApiApp} />
        <StatsCard title="服务器总数" value={serverCount} Icon={IconChecklist} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} m="lg">
        <StatsCard title="工具总数" value={toolCount} Icon={IconTool} />
        <StatsCard title="工具数量 (所有服务器)" value={totalTools} Icon={IconApi} />
        <StatsCard title="总调用次数" value={totalCalls} Icon={IconChecklist} />
      </SimpleGrid>
    </div>
  );
}
