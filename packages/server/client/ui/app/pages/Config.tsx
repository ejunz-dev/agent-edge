import {
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconReload, IconDeviceFloppy } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';

interface ClientConfig {
  server: string;
  port?: number;
  vtuber?: {
    enabled: boolean;
    vtubestudio?: {
      host: string;
      port: number;
      enabled: boolean;
    };
  };
}

export default function Config() {
  const queryClient = useQueryClient();
  const [localConfig, setLocalConfig] = useState<ClientConfig>({ 
    server: '',
    port: 5283,
    vtuber: {
      enabled: true,
      vtubestudio: {
        host: '127.0.0.1',
        port: 8001,
        enabled: true,
      },
    },
  });

  // 获取配置
  const { data: configData, isLoading } = useQuery({
    queryKey: ['client-config'],
    queryFn: async () => {
      const res = await fetch('/api/client-config');
      if (!res.ok) throw new Error('获取配置失败');
      return res.json();
    },
  });

  // 当服务器配置加载后，初始化本地状态
  useEffect(() => {
    if (configData?.config) {
      setLocalConfig(configData.config);
    }
  }, [configData]);

  // 保存并重载配置
  const saveAndReloadConfig = useMutation({
    mutationFn: async (newConfig: ClientConfig) => {
      // 直接调用 reload，它会先保存配置
      const reloadRes = await fetch('/api/client-config/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      if (!reloadRes.ok) {
        const error = await reloadRes.json();
        throw new Error(error.error || '保存并重载失败');
      }
      return reloadRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-config'] });
      notifications.show({
        title: '成功',
        message: '配置已保存',
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: '错误',
        message: error.message,
        color: 'red',
      });
    },
  });

  const handleConfigChange = (key: keyof ClientConfig, value: any) => {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleVtuberChange = (key: string, value: any) => {
    setLocalConfig((prev) => ({
      ...prev,
      vtuber: {
        enabled: prev.vtuber?.enabled ?? true,
        vtubestudio: prev.vtuber?.vtubestudio,
        [key]: value,
      },
    }));
  };

  const handleVtsChange = (key: string, value: any) => {
    setLocalConfig((prev) => ({
      ...prev,
      vtuber: {
        enabled: prev.vtuber?.enabled ?? true,
        vtubestudio: {
          host: prev.vtuber?.vtubestudio?.host || '127.0.0.1',
          port: prev.vtuber?.vtubestudio?.port || 8001,
          enabled: prev.vtuber?.vtubestudio?.enabled ?? true,
          [key]: value,
        },
      },
    }));
  };

  if (isLoading) {
    return <div>加载中...</div>;
  }

  const config: ClientConfig = localConfig || configData?.config || { 
    server: '',
    port: 5283,
    vtuber: {
      enabled: true,
      vtubestudio: {
        host: '127.0.0.1',
        port: 8001,
        enabled: true,
      },
    },
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>客户端配置</Title>
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={() => {
            if (localConfig) {
              saveAndReloadConfig.mutate(localConfig);
            }
          }}
          loading={saveAndReloadConfig.isPending}
          disabled={!localConfig}
        >
          保存配置
        </Button>
      </Group>

      <Paper withBorder p="md">
        <Title order={3} mb="md">
          服务器设置
        </Title>

        <Stack gap="md">
          <div>
            <Text size="sm" fw={500} mb={4}>
              服务器地址
            </Text>
            <TextInput
              value={config.server || ''}
              onChange={(e) => handleConfigChange('server', e.target.value)}
              placeholder="http://localhost:5283"
              style={{ maxWidth: '500px' }}
            />
            <Text size="xs" c="dimmed" mt={4}>
              客户端连接的服务器地址
            </Text>
          </div>
          
          <div>
            <Text size="sm" fw={500} mb={4}>
              本地服务器端口
            </Text>
            <NumberInput
              value={config.port || 5283}
              onChange={(val) => handleConfigChange('port', val ?? 5283)}
              min={1024}
              max={65535}
              style={{ maxWidth: '200px' }}
            />
            <Text size="xs" c="dimmed" mt={4}>
              Client UI 和本地服务监听的端口
            </Text>
          </div>
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Title order={3} mb="md">
          VTube Studio 设置
        </Title>

        <Stack gap="md">
          <Group justify="space-between">
            <div>
              <Text size="sm" fw={500} mb={4}>
                启用 VTube Studio
              </Text>
              <Text size="xs" c="dimmed">
                控制是否启用 VTube Studio 连接和动画控制
              </Text>
            </div>
            <Switch
              checked={config.vtuber?.enabled !== false}
              onChange={(e) => handleVtuberChange('enabled', e.currentTarget.checked)}
            />
          </Group>

          {config.vtuber?.enabled !== false && (
            <div style={{ marginLeft: '20px', paddingLeft: '16px', borderLeft: '2px solid #e0e0e0' }}>
              <Stack gap="md">
                <Group justify="space-between">
                  <div>
                    <Text size="sm" fw={500} mb={4}>
                      启用 VTube Studio 连接
                    </Text>
                    <Text size="xs" c="dimmed">
                      连接到 VTube Studio 进行动画控制
                    </Text>
                  </div>
                  <Switch
                    checked={config.vtuber?.vtubestudio?.enabled !== false}
                    onChange={(e) => handleVtsChange('enabled', e.currentTarget.checked)}
                  />
                </Group>

                {config.vtuber?.vtubestudio?.enabled !== false && (
                  <>
                    <div>
                      <Text size="sm" fw={500} mb={4}>
                        VTube Studio 主机
                      </Text>
                      <TextInput
                        value={config.vtuber?.vtubestudio?.host || '127.0.0.1'}
                        onChange={(e) => handleVtsChange('host', e.currentTarget.value)}
                        placeholder="127.0.0.1"
                        style={{ maxWidth: '300px' }}
                      />
                    </div>

                    <div>
                      <Text size="sm" fw={500} mb={4}>
                        VTube Studio 端口
                      </Text>
                      <NumberInput
                        value={config.vtuber?.vtubestudio?.port || 8001}
                        onChange={(val) => handleVtsChange('port', val ?? 8001)}
                        min={1024}
                        max={65535}
                        style={{ maxWidth: '200px' }}
                      />
                    </div>
                  </>
                )}
              </Stack>
            </div>
          )}
        </Stack>
      </Paper>

      <Card withBorder p="md">
        <Text size="sm" c="dimmed">
          注意：配置修改后会保存到 config.client.yaml，VTube Studio 配置需要重启客户端才能生效。
        </Text>
      </Card>
    </Stack>
  );
}

