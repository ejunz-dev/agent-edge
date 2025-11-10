import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconReload, IconDots, IconPlus, IconTrash, IconPlug, IconApi } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';

interface ConfigSchema {
  [key: string]: {
    type: string;
    default?: any;
    description?: string;
    properties?: ConfigSchema;
    items?: { type: string; properties?: ConfigSchema };
    required?: boolean;
  };
}

interface Broker {
  name: string;
  mqttUrl: string;
  baseTopic: string;
  username: string;
  password: string;
  enabled: boolean;
  connected?: boolean;
  reconnect: {
    enabled: boolean;
    period: number;
  };
}

interface Config {
  enabled: boolean;
  reconnect: {
    enabled: boolean;
    period: number;
  };
  brokers: Broker[];
}

interface ConfigStatus {
  enabled: boolean;
  brokers: Broker[];
}

// 配置项组件
function ConfigItem({
  label,
  value,
  onChange,
  type,
  description,
  min,
  max,
  step,
}: {
  label: string;
  value: any;
  onChange: (value: any) => void;
  type: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const handleChange = (newValue: any) => {
    // 直接更新，不保存到服务器
    onChange(newValue);
  };

  let input: React.ReactNode;
  switch (type) {
    case 'boolean':
      input = (
        <Switch
          checked={value}
          onChange={(e) => handleChange(e.currentTarget.checked)}
          size="md"
        />
      );
      break;
    case 'number':
      input = (
        <NumberInput
          value={value}
          onChange={(val) => handleChange(val ?? 0)}
          min={min}
          max={max}
          step={step}
          style={{ width: '200px' }}
        />
      );
      break;
    case 'password':
      input = (
        <PasswordInput
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          style={{ width: '300px' }}
        />
      );
      break;
    default:
      input = (
        <TextInput
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          style={{ width: '300px' }}
        />
      );
  }

  return (
    <Group justify="space-between" align="flex-start" style={{ marginBottom: '16px' }}>
      <div style={{ flex: 1 }}>
        <Group gap="xs" mb={4}>
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {description && (
            <Tooltip label={description}>
              <ActionIcon size="xs" variant="subtle">
                <IconDots size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        {input}
      </div>
    </Group>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();

  // 获取 Schema
  const { data: schemaData } = useQuery({
    queryKey: ['mqtt-bridge-schema'],
    queryFn: async () => {
      const res = await fetch('/api/mqtt-bridge-config/schema');
      if (!res.ok) throw new Error('获取 Schema 失败');
      return res.json();
    },
  });

  // 获取配置
  const { data: configData, isLoading } = useQuery({
    queryKey: ['mqtt-bridge-config'],
    queryFn: async () => {
      const res = await fetch('/api/mqtt-bridge-config');
      if (!res.ok) throw new Error('获取配置失败');
      return res.json();
    },
  });

  // 本地配置状态（用于实时编辑）
  const [localConfig, setLocalConfig] = useState<Config | null>(null);

  // 当服务器配置加载后，初始化本地状态
  useEffect(() => {
    if (configData?.config) {
      setLocalConfig(configData.config);
    }
  }, [configData]);

  // 获取状态
  const { data: statusData } = useQuery({
    queryKey: ['mqtt-bridge-status'],
    queryFn: async () => {
      const res = await fetch('/api/mqtt-bridge-config/status');
      if (!res.ok) throw new Error('获取状态失败');
      return res.json();
    },
    refetchInterval: 5000,
  });

  // 保存并重载配置
  const saveAndReloadConfig = useMutation({
    mutationFn: async (newConfig: Config) => {
      // 直接调用 reload，它会先保存配置再重载
      const reloadRes = await fetch('/api/mqtt-bridge-config/reload', {
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
      queryClient.invalidateQueries({ queryKey: ['mqtt-bridge-config', 'mqtt-bridge-status'] });
      notifications.show({
        title: '成功',
        message: '配置已保存并重新加载',
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

  // 使用本地配置或默认配置
  const config: Config = localConfig || configData?.config || {
    enabled: true,
    reconnect: { enabled: true, period: 5000 },
    brokers: [],
  };

  const status: ConfigStatus | undefined = statusData?.status;

  // 更新本地配置状态（不保存到服务器）
  const handleConfigChange = (key: string, value: any) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [key]: value });
  };

  const handleReconnectChange = (key: string, value: any) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      reconnect: { ...localConfig.reconnect, [key]: value },
    });
  };

  const handleBrokerChange = (index: number, updates: Partial<Broker>) => {
    if (!localConfig) return;
    const newBrokers = [...localConfig.brokers];
    newBrokers[index] = { ...newBrokers[index], ...updates };
    setLocalConfig({ ...localConfig, brokers: newBrokers });
  };

  const handleAddBroker = () => {
    if (!localConfig) return;
    const newBroker: Broker = {
      name: `broker-${Date.now()}`,
      mqttUrl: 'mqtt://localhost:1883',
      baseTopic: 'zigbee2mqtt',
      username: '',
      password: '',
      enabled: true,
      reconnect: { enabled: true, period: 5000 },
    };
    setLocalConfig({ ...localConfig, brokers: [...localConfig.brokers, newBroker] });
  };

  const handleDeleteBroker = (index: number) => {
    if (!localConfig) return;
    const newBrokers = localConfig.brokers.filter((_, i) => i !== index);
    setLocalConfig({ ...localConfig, brokers: newBrokers });
  };

  // MCP Provider 配置
  const { data: mcpConfigData, isLoading: mcpConfigLoading } = useQuery({
    queryKey: ['node-mcp-config'],
    queryFn: async () => {
      const res = await fetch('/api/node/mcp-config');
      if (!res.ok) throw new Error('获取 MCP 配置失败');
      return res.json();
    },
  });

  const [localMCPConfig, setLocalMCPConfig] = useState<any>(null);

  useEffect(() => {
    if (mcpConfigData?.ws) {
      setLocalMCPConfig(mcpConfigData.ws);
    }
  }, [mcpConfigData]);

  const saveMCPConfigMutation = useMutation({
    mutationFn: async (newConfig: any) => {
      const res = await fetch('/api/node/mcp-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ws: newConfig }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || '保存配置失败');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['node-mcp-config'] });
      notifications.show({
        title: '成功',
        message: 'MCP Provider 配置已保存',
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

  const mcpConfig = localMCPConfig || mcpConfigData?.ws || {
    endpoint: '',
    localEndpoint: '/mcp/ws',
    enabled: true,
  };

  const handleMCPConfigChange = (key: string, value: any) => {
    if (!localMCPConfig) return;
    setLocalMCPConfig({ ...localMCPConfig, [key]: value });
  };

  if (isLoading || mcpConfigLoading) {
    return <div>加载中...</div>;
  }

  return (
    <Stack gap="md">
      <Title order={2}>配置</Title>
      
      <Tabs defaultValue="mqtt-bridge">
        <Tabs.List>
          <Tabs.Tab value="mqtt-bridge" leftSection={<IconPlug size={16} />}>
            MQTT Bridge
          </Tabs.Tab>
          <Tabs.Tab value="mcp-provider" leftSection={<IconApi size={16} />}>
            MCP Provider
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="mqtt-bridge" pt="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={3}>MQTT Bridge 配置</Title>
        <Button
          leftSection={<IconReload size={16} />}
          onClick={() => {
            if (localConfig) {
              saveAndReloadConfig.mutate(localConfig);
            }
          }}
          loading={saveAndReloadConfig.isPending}
          disabled={!localConfig}
        >
          保存并重载配置
        </Button>
      </Group>

      {/* 状态卡片 */}
      {status && (
        <Group>
          <Card withBorder p="md" style={{ minWidth: '150px' }}>
            <Text size="xs" c="dimmed" mb={4}>
              服务状态
            </Text>
            <Badge color={status.enabled ? 'green' : 'red'} size="lg">
              {status.enabled ? '已启用' : '已禁用'}
            </Badge>
          </Card>
          <Card withBorder p="md" style={{ minWidth: '150px' }}>
            <Text size="xs" c="dimmed" mb={4}>
              已连接 Broker
            </Text>
            <Text size="xl" fw={700}>
              {status.brokers.filter((b) => b.connected).length}/{status.brokers.length}
            </Text>
          </Card>
        </Group>
      )}

      <Paper withBorder p="md">
        <Title order={3} mb="md">
          基础设置
        </Title>

        <ConfigItem
          label="是否启用MQTT桥接"
          value={config.enabled}
          onChange={(val) => handleConfigChange('enabled', val)}
          type="boolean"
          description={schemaData?.schema?.enabled?.description}
        />

        <div style={{ marginLeft: '20px', marginTop: '16px', paddingLeft: '16px', borderLeft: '2px solid #e0e0e0' }}>
          <Text size="sm" fw={500} mb="md" c="dimmed">
            全局重连配置
          </Text>

          <ConfigItem
            label="是否启用自动重连"
            value={config.reconnect.enabled}
            onChange={(val) => handleReconnectChange('enabled', val)}
            type="boolean"
            description={schemaData?.schema?.reconnect?.properties?.enabled?.description}
          />

          <ConfigItem
            label="重连间隔 (毫秒)"
            value={config.reconnect.period}
            onChange={(val) => handleReconnectChange('period', val)}
            type="number"
            min={1000}
            step={1000}
            description={schemaData?.schema?.reconnect?.properties?.period?.description}
          />
        </div>
      </Paper>

      {/* Broker 列表 */}
      <Paper withBorder p="md">
        <Group justify="space-between" mb="md">
          <Title order={3}>Broker 列表</Title>
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={handleAddBroker}
            disabled={!localConfig}
          >
            添加 Broker
          </Button>
        </Group>
        {config.brokers.length === 0 ? (
          <Text c="dimmed">暂无配置的 Broker</Text>
        ) : (
          <Stack gap="md">
            {config.brokers.map((broker, index) => {
              const brokerStatus = status?.brokers.find((b) => b.name === broker.name);
              return (
                <Card key={index} withBorder p="md">
                  <Group justify="space-between" mb="md">
                    <Group>
                      <Text fw={600}>{broker.name}</Text>
                      <Badge color={brokerStatus?.connected ? 'green' : 'red'}>
                        {brokerStatus?.connected ? '已连接' : '未连接'}
                      </Badge>
                      {!broker.enabled && <Badge color="gray">已禁用</Badge>}
                    </Group>
                    <ActionIcon
                      color="red"
                      variant="subtle"
                      onClick={() => handleDeleteBroker(index)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                  <Stack gap="sm">
                    <ConfigItem
                      label="Broker名称"
                      value={broker.name}
                      onChange={(val) => handleBrokerChange(index, { name: val })}
                      type="string"
                    />
                    <ConfigItem
                      label="MQTT连接地址"
                      value={broker.mqttUrl}
                      onChange={(val) => handleBrokerChange(index, { mqttUrl: val })}
                      type="string"
                    />
                    <ConfigItem
                      label="基础主题"
                      value={broker.baseTopic}
                      onChange={(val) => handleBrokerChange(index, { baseTopic: val })}
                      type="string"
                    />
                    <ConfigItem
                      label="用户名"
                      value={broker.username}
                      onChange={(val) => handleBrokerChange(index, { username: val })}
                      type="string"
                    />
                    <ConfigItem
                      label="密码"
                      value={broker.password}
                      onChange={(val) => handleBrokerChange(index, { password: val })}
                      type="password"
                    />
                    <ConfigItem
                      label="是否启用此Broker"
                      value={broker.enabled}
                      onChange={(val) => handleBrokerChange(index, { enabled: val })}
                      type="boolean"
                    />
                  </Stack>
                </Card>
              );
            })}
          </Stack>
        )}
      </Paper>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="mcp-provider" pt="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={3}>MCP Provider 配置</Title>
              <Button
                leftSection={<IconReload size={16} />}
                onClick={() => {
                  if (localMCPConfig) {
                    saveMCPConfigMutation.mutate(localMCPConfig);
                  }
                }}
                loading={saveMCPConfigMutation.isPending}
                disabled={!localMCPConfig}
              >
                保存配置
              </Button>
            </Group>

            <Paper withBorder p="md">
              <Title order={4} mb="md">
                基础设置
              </Title>

              <ConfigItem
                label="是否启用 MCP Provider"
                value={mcpConfig.enabled}
                onChange={(val) => handleMCPConfigChange('enabled', val)}
                type="boolean"
                description="启用后，Node 将作为 MCP Provider 提供工具给上游服务器"
              />

              <ConfigItem
                label="上游 MCP Endpoint"
                value={mcpConfig.endpoint || ''}
                onChange={(val) => handleMCPConfigChange('endpoint', val)}
                type="string"
                description="上游 MCP WebSocket endpoint 完整 URL，例如: wss://example.com/mcp/ws?token=xxx"
              />

              <ConfigItem
                label="本地 WebSocket 路径"
                value={mcpConfig.localEndpoint || '/mcp/ws'}
                onChange={(val) => handleMCPConfigChange('localEndpoint', val)}
                type="string"
                description="本地 WebSocket 服务器路径，用于接收外部 MCP 请求"
              />
            </Paper>

            <Paper withBorder p="md">
              <Title order={4} mb="md">
                说明
              </Title>
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  • <strong>上游 MCP Endpoint</strong>: 配置后，Node 将作为客户端连接到该 endpoint，向上游提供工具
                </Text>
                <Text size="sm" c="dimmed">
                  • <strong>本地 WebSocket 路径</strong>: 本地服务器监听路径，外部可以通过此路径调用 Node 的工具
                </Text>
                <Text size="sm" c="dimmed">
                  • 配置保存后需要重启 Node 服务才能生效
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
