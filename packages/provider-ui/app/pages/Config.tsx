import {
  Button, Card, Group, Paper, Stack, Switch, Text, TextInput, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

export default function Config() {
  const queryClient = useQueryClient();

  const { data: configData } = useQuery({
    queryKey: ['provider_config'],
    queryFn: () => fetch('/api/config').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (config: any) => {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error('Failed to update config');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider_config'] });
      notifications.show({
        title: '成功',
        message: '配置已更新',
        color: 'green',
      });
    },
    onError: () => {
      notifications.show({
        title: '错误',
        message: '更新配置失败',
        color: 'red',
      });
    },
  });

  const [wsEndpoint, setWsEndpoint] = useState(configData?.ws?.endpoint || '/mcp/ws');
  const [wsEnabled, setWsEnabled] = useState(configData?.ws?.enabled !== false);

  React.useEffect(() => {
    if (configData) {
      setWsEndpoint(configData.ws?.endpoint || '/mcp/ws');
      setWsEnabled(configData.ws?.enabled !== false);
    }
  }, [configData]);

  const handleSave = () => {
    updateConfigMutation.mutate({
      ws: {
        endpoint: wsEndpoint,
        enabled: wsEnabled,
      },
    });
  };

  return (
    <Stack gap="md">
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Title order={2} mb="md">WebSocket 配置</Title>
        <Stack gap="md">
          <Paper p="md" withBorder>
            <Stack gap="md">
              <Group justify="space-between">
                <Text fw={500}>启用 WebSocket</Text>
                <Switch
                  checked={wsEnabled}
                  onChange={(e) => setWsEnabled(e.currentTarget.checked)}
                />
              </Group>
              <TextInput
                label="WebSocket 接入点"
                placeholder="/mcp/ws"
                value={wsEndpoint}
                onChange={(e) => setWsEndpoint(e.currentTarget.value)}
                disabled={!wsEnabled}
              />
              <Text size="sm" c="dimmed">
                WebSocket 接入点路径，客户端可以通过此路径连接到 MCP Provider
              </Text>
            </Stack>
          </Paper>
          <Group>
            <Button onClick={handleSave} loading={updateConfigMutation.isPending}>
              保存配置
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}

