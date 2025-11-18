import {
  Group, Paper, SimpleGrid, Text, Title,
} from '@mantine/core';
import {
  IconPlug, IconMessage, IconSettings, IconWifi,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';

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
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [audioStatus, setAudioStatus] = useState<'enabled' | 'disabled'>('disabled');

  // 检查 WebSocket 连接状态
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 在开发模式下，直接连接到后端服务器（避免 webpack-dev-server 代理问题）
    const isDev = window.location.hostname === 'localhost' && window.location.port === '8082';
    const host = isDev ? 'localhost:5283' : window.location.host;
    const wsUrl = `${protocol}//${host}/client-ws`;
    
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    
    const connect = () => {
      if (ws?.readyState === WebSocket.OPEN) return;
      
      setWsStatus('connecting');
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        setWsStatus('connected');
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };
      
      ws.onclose = () => {
        setWsStatus('disconnected');
        reconnectTimer = setTimeout(connect, 3000);
      };
      
      ws.onerror = () => {
        setWsStatus('disconnected');
      };
    };
    
    connect();
    
    return () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  // 检查音频播放器状态
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const audioWsUrl = `${protocol}//${window.location.host}/audio-ws`;
    
    let audioWs: WebSocket | null = null;
    
    const checkAudio = () => {
      audioWs = new WebSocket(audioWsUrl);
      
      audioWs.onopen = () => {
        setAudioStatus('enabled');
        audioWs?.close();
      };
      
      audioWs.onerror = () => {
        setAudioStatus('disabled');
      };
    };
    
    checkAudio();
    
    return () => {
      if (audioWs) audioWs.close();
    };
  }, []);

  // 获取服务器状态
  const { data: serverStatus } = useQuery({
    queryKey: ['client_status'],
    queryFn: () => fetch('/edge').then((res) => res.json()),
    refetchInterval: 5000,
  });

  return (
    <div>
      <Title order={2} mb="lg">Client Dashboard</Title>
      
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} m="lg">
        <StatsCard 
          title="WebSocket 连接" 
          value={wsStatus === 'connected' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '未连接'} 
          Icon={IconWifi}
          color={wsStatus === 'connected' ? 'green' : wsStatus === 'connecting' ? 'yellow' : 'red'}
        />
        <StatsCard 
          title="音频播放器" 
          value={audioStatus === 'enabled' ? '已启用' : '未启用'} 
          Icon={IconPlug}
          color={audioStatus === 'enabled' ? 'green' : 'gray'}
        />
        <StatsCard 
          title="服务器状态" 
          value={serverStatus?.ok ? '正常' : '未知'} 
          Icon={IconSettings}
          color={serverStatus?.ok ? 'green' : 'gray'}
        />
        <StatsCard 
          title="对话历史" 
          value="查看对话页" 
          Icon={IconMessage}
        />
      </SimpleGrid>
    </div>
  );
}

