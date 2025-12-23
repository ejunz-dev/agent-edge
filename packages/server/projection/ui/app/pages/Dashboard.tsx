import {
  Group, Paper, SimpleGrid, Text, Title,
} from '@mantine/core';
import {
  IconGauge, IconWifi, IconWorld, IconRadar,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';

function StatsCard({ title, value, Icon, color = 'blue' }) {
  return (
    <Paper withBorder p="md" radius="md" key={title}>
      <Group justify="space-between">
        <Text size="md" c="dimmed">
          {title}
        </Text>
        <Icon size="2rem" stroke={1.5} color={color} />
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
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');

  // WebSocket 状态（连到 projection 自己的 /projection-ws）
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/projection-ws`;

    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

      setWsStatus('connecting');
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setWsStatus('connected');
        if (reconnectTimer) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        reconnectTimer = window.setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setWsStatus('disconnected');
      };
    };

    connect();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, []);

  // 基本信息（来自 /api/projection/info）
  const { data: info } = useQuery({
    queryKey: ['projection_info'],
    queryFn: () => fetch('/api/projection/info').then((res) => res.json()),
    refetchInterval: 5000,
  });

  return (
    <div>
      <Title order={2} mb="lg">Projection Dashboard</Title>

      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} m="lg">
        <StatsCard
          title="WebSocket 连接"
          value={wsStatus === 'connected' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '未连接'}
          Icon={IconWifi}
          color={wsStatus === 'connected' ? 'green' : wsStatus === 'connecting' ? 'yellow' : 'red'}
        />
        <StatsCard
          title="运行模式"
          value={info?.mode || '未知'}
          Icon={IconGauge}
          color="blue"
        />
        <StatsCard
          title="端口"
          value={info?.port ?? '-'}
          Icon={IconWorld}
          color="teal"
        />
        <StatsCard
          title="GSI 状态"
          value={info?.gsi?.isActive ? '活跃' : '未接收'}
          Icon={IconRadar}
          color={info?.gsi?.isActive ? 'green' : 'gray'}
        />
      </SimpleGrid>
    </div>
  );
}


