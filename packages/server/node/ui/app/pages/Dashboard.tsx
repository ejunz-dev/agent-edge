import {
  Group, Paper, SimpleGrid, Text, Title,
} from '@mantine/core';
import {
  IconApi, IconChecklist, IconPlug, IconSettings,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import React from 'react';

export function StatsCard({ title, value, Icon, color = 'blue' }) {
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
  const { data: bridgeStatus } = useQuery({
    queryKey: ['mqtt_bridge_status'],
    queryFn: () => fetch('/api/mqtt-bridge-config/status').then((res) => res.json()),
    refetchInterval: 5000,
  });

  const { data: zigbeeStatus } = useQuery({
    queryKey: ['zigbee_status'],
    queryFn: () => fetch('/zigbee2mqtt/status').then((res) => res.json()),
    refetchInterval: 5000,
  });

  const bridgeEnabled = bridgeStatus?.status?.enabled ?? false;
  const connectedBrokers = bridgeStatus?.status?.brokers?.filter((b: any) => b.connected).length || 0;
  const totalBrokers = bridgeStatus?.status?.brokers?.length || 0;
  const zigbeeConnected = zigbeeStatus?.connected ?? false;

  return (
    <div>
      <Title order={2} mb="lg">Node Dashboard</Title>
      
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} m="lg">
        <StatsCard 
          title="MQTT Bridge" 
          value={bridgeEnabled ? '已启用' : '已禁用'} 
          Icon={IconPlug}
          color={bridgeEnabled ? 'green' : 'gray'}
        />
        <StatsCard 
          title="已连接 Broker" 
          value={`${connectedBrokers}/${totalBrokers}`} 
          Icon={IconApi}
          color={connectedBrokers > 0 ? 'green' : 'red'}
        />
        <StatsCard 
          title="Zigbee 状态" 
          value={zigbeeConnected ? '已连接' : '未连接'} 
          Icon={IconChecklist}
          color={zigbeeConnected ? 'green' : 'red'}
        />
        <StatsCard 
          title="总 Broker 数" 
          value={totalBrokers} 
          Icon={IconSettings}
        />
      </SimpleGrid>
    </div>
  );
}

