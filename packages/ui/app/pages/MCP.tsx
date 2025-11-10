import {
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

export default function MCP() {
  const queryClient = useQueryClient();
  const [level, setLevel] = useState<string>('');
  const [tool, setTool] = useState<string>('');
  const [editingTool, setEditingTool] = useState<any | null>(null);
  const [editedDescription, setEditedDescription] = useState<string>('');

  const { data: logsData, refetch: refetchLogs } = useQuery({
    queryKey: ['mcp_logs', level, tool],
    queryFn: () => fetch('/mcp/logs?' + new URLSearchParams({
      ...level && { level },
      ...tool && { tool },
      limit: '100',
    }).toString()).then((res) => res.json()),
    refetchInterval: 5000,
  });

  const { data: serversData } = useQuery({
    queryKey: ['mcp_servers'],
    queryFn: () => fetch('/mcp/servers').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const { data: toolsData, refetch: refetchTools } = useQuery({
    queryKey: ['mcp_tools'],
    queryFn: () => fetch('/mcp/tools?list=true').then((res) => res.json()),
    refetchInterval: 30000,
  });

  const handleTestTool = async (toolName: string) => {
    try {
      const res = await fetch('/mcp/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'call',
          tool: toolName,
          arguments: {},
        }),
      });
      const result = await res.json();
      if (result.success) {
        notifications.show({
          title: '成功',
          message: `工具 ${toolName} 调用成功`,
          color: 'green',
        });
        refetchTools();
        refetchLogs();
      } else {
        notifications.show({
          title: '错误',
          message: result.error?.message || '工具调用失败',
          color: 'red',
        });
      }
    } catch (e) {
      console.error(e);
      notifications.show({ title: '错误', message: '工具调用失败', color: 'red' });
    }
  };

  const updateToolMutation = useMutation({
    mutationFn: async ({ _id, description }: { _id: string; description: string }) => {
      const res = await fetch('/mcp/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'update', _id, description }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || '更新失败');
      }
      return res.json();
    },
    onSuccess: () => {
      notifications.show({
        title: '成功',
        message: '工具描述已更新',
        color: 'green',
      });
      queryClient.invalidateQueries({ queryKey: ['mcp_tools'] });
    },
    onError: (error: Error) => {
      notifications.show({
        title: '错误',
        message: error.message || '更新失败',
        color: 'red',
      });
    },
  });

  const handleEditTool = (item: any) => {
    setEditingTool(item);
    setEditedDescription(item?.description || item?.metadata?.defaultDescription || '');
  };

  const handleSaveDescription = () => {
    if (!editingTool) return;
    const docId = editingTool._id || editingTool?.metadata?.docId;
    if (!docId) {
      notifications.show({ title: '错误', message: '无法确定工具标识，更新失败', color: 'red' });
      return;
    }
    updateToolMutation.mutate(
      { _id: docId, description: editedDescription },
      {
        onSuccess: () => {
          setEditingTool(null);
          setEditedDescription('');
        },
      },
    );
  };

  const handleSync = async () => {
    try {
      const results = await Promise.all(
        (serversData?.servers || []).map(async (server: any) => {
          const res = await fetch('/mcp/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation: 'sync', name: server.name }),
          });
          return res.json();
        }),
      );
      notifications.show({ title: '成功', message: `已同步 ${results.length} 个 MCP 服务器`, color: 'green' });
    } catch (e) {
      console.error(e);
      notifications.show({ title: '错误', message: '同步失败', color: 'red' });
    }
  };

  const getLevelColor = (lvl: string) => {
    switch (lvl) {
      case 'error': return 'red';
      case 'warn': return 'yellow';
      case 'debug': return 'blue';
      default: return 'gray';
    }
  };

  return (
    <Stack gap="md">
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={2}>MCP 服务器</Title>
          <Button onClick={handleSync}>同步</Button>
        </Group>
        <Stack gap="sm">
          {serversData?.servers?.map((server: any) => (
            <Paper key={server._id} p="md" withBorder>
              <Group justify="space-between">
                <Group>
                  <Text fw={500}>{server.name}</Text>
                  <Badge color={server.status === 'online' ? 'green' : 'red'}>
                    {server.status}
                  </Badge>
                  <Text size="sm" c="dimmed">{server.endpoint}</Text>
                </Group>
                <Group>
                  <Text size="sm">工具数: {server.toolCount}</Text>
                  <Text size="sm">总调用: {server.totalCalls}</Text>
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      </Card>

      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Title order={2} mb="md">MCP 工具 ({toolsData?.total || 0})</Title>
        <ScrollArea h={300}>
          <Stack gap="xs">
            {toolsData?.tools?.map((item: any, index: number) => (
              <Paper key={item._id || index} p="sm" withBorder>
                <Group justify="space-between">
                  <Group gap="xs">
                    <Text fw={500}>{item.name}</Text>
                    {item.server && <Badge size="sm">{item.server}</Badge>}
                    {item.metadata?.nodeId && (
                      <Badge size="sm" color="blue">
                        节点 {item.metadata.nodeId}
                      </Badge>
                    )}
                    {item.metadata?.status && (
                      <Badge
                        size="sm"
                        color={item.metadata.status === 'online' ? 'green' : 'gray'}
                      >
                        {item.metadata.status === 'online' ? '在线' : '离线'}
                      </Badge>
                    )}
                    {item.metadata?.category && (
                      <Badge size="sm" variant="light">
                        {item.metadata.category}
                      </Badge>
                    )}
                  </Group>
                  <Group>
                    <Text size="sm">调用: {item.callCount || 0}</Text>
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => handleEditTool(item)}
                    >
                      编辑
                    </Button>
                    <Button size="xs" onClick={() => handleTestTool(item.name)}>
                      测试
                    </Button>
                  </Group>
                </Group>
                {item.description && (
                  <Text size="xs" c="dimmed" mt="xs">
                    {item.description}
                  </Text>
                )}
                {item.metadata?.friendlyName && (
                  <Text size="xs" c="dimmed" mt={4}>
                    设备: {item.metadata.friendlyName} {item.metadata.deviceId ? `(${item.metadata.deviceId})` : ''}
                  </Text>
                )}
              </Paper>
            ))}
          </Stack>
        </ScrollArea>
      </Card>

      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={2}>MCP 日志</Title>
          <Group>
            <Select
              placeholder="过滤日志级别"
              data={['', 'debug', 'info', 'warn', 'error']}
              value={level}
              onChange={(value) => setLevel(value || '')}
              clearable
            />
            <Select
              placeholder="过滤工具"
              data={['', ...(toolsData?.tools?.map((t: any) => t.name) || [])]}
              value={tool}
              onChange={(value) => setTool(value || '')}
              clearable
            />
            <Button onClick={() => refetchLogs()}>刷新</Button>
          </Group>
        </Group>
        <ScrollArea h={400}>
          <Stack gap="xs">
            {logsData?.logs?.map((log: any) => (
              <Paper key={log._id} p="sm" withBorder>
                <Group gap="xs" mb="xs">
                  <Badge color={getLevelColor(log.level)} size="sm">
                    {log.level}
                  </Badge>
                  {log.tool && (
                    <Badge color="blue" size="sm">
                      {log.tool}
                    </Badge>
                  )}
                  <Text size="xs" c="dimmed">
                    {new Date(log.timestamp).toLocaleString('zh-CN')}
                  </Text>
                </Group>
                <Text size="sm">{log.message}</Text>
                {log.metadata && (
                  <Code block mt="xs" style={{ fontSize: '0.8rem' }}>
                    {JSON.stringify(log.metadata, null, 2)}
                  </Code>
                )}
              </Paper>
            ))}
          </Stack>
        </ScrollArea>
      </Card>

      <Modal
        opened={!!editingTool}
        onClose={() => {
          setEditingTool(null);
          setEditedDescription('');
        }}
        title={editingTool ? `编辑 ${editingTool.name} 描述` : '编辑工具描述'}
        centered
      >
        <Stack gap="md">
          <Textarea
            value={editedDescription}
            onChange={(event) => setEditedDescription(event.currentTarget.value)}
            minRows={4}
            autosize
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setEditingTool(null);
                setEditedDescription('');
              }}
            >
              取消
            </Button>
            <Button
              loading={updateToolMutation.isPending}
              onClick={handleSaveDescription}
            >
              保存
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

