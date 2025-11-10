import {
  Badge, Button, Card, Code, Group, Modal, Paper, ScrollArea, Stack, Text, Textarea, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconTool, IconCheck, IconX, IconRefresh } from '@tabler/icons-react';
import React, { useState } from 'react';

export default function MCPTools() {
  const queryClient = useQueryClient();
  const [editingTool, setEditingTool] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState('');

  const { data: toolsData, refetch: refetchTools } = useQuery({
    queryKey: ['node_mcp_tools'],
    queryFn: () => fetch('/api/node/mcp-tools').then((res) => res.json()),
    refetchInterval: 10000,
  });

  const updateToolMutation = useMutation({
    mutationFn: async ({ toolName, description }: { toolName: string; description: string }) => {
      const res = await fetch('/api/node/mcp-tools/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName,
          description,
        }),
      });
      if (!res.ok) throw new Error('更新工具描述失败');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['node_mcp_tools'] });
      setEditingTool(null);
      setEditDescription('');
      notifications.show({
        title: '成功',
        message: '工具描述已更新',
        color: 'green',
      });
    },
    onError: () => {
      notifications.show({
        title: '错误',
        message: '更新工具描述失败',
        color: 'red',
      });
    },
  });

  const registerToolsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/node/mcp-tools/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('注册工具失败');
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['node_mcp_tools'] });
      notifications.show({
        title: '成功',
        message: `已识别 ${data.devicesFound} 个设备，注册了 ${data.toolsRegistered} 个工具`,
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: '错误',
        message: error.message || '注册工具失败',
        color: 'red',
      });
    },
  });

  const handleTestTool = async (toolName: string) => {
    try {
      const res = await fetch('/api/node/mcp-tools/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName,
          arguments: { state: 'TOGGLE' },
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
      } else {
        notifications.show({
          title: '错误',
          message: result.error || '工具调用失败',
          color: 'red',
        });
      }
    } catch (e) {
      console.error(e);
      notifications.show({ title: '错误', message: '工具调用失败', color: 'red' });
    }
  };

  const handleStartEdit = (tool: any) => {
    setEditingTool(tool.name);
    setEditDescription(tool.description || '');
  };

  const handleSaveEdit = () => {
    if (!editingTool) return;
    updateToolMutation.mutate({ toolName: editingTool, description: editDescription });
  };

  const handleCancelEdit = () => {
    setEditingTool(null);
    setEditDescription('');
  };

  const tools = toolsData?.tools || [];

  return (
    <Stack gap="md">
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={2}>MCP 工具管理</Title>
          <Group>
            <Badge size="lg" color="blue">
              总计: {tools.length}
            </Badge>
            <Button
              leftSection={<IconRefresh size={16} />}
              onClick={() => registerToolsMutation.mutate()}
              loading={registerToolsMutation.isPending}
              color="green"
            >
              识别设备并注册工具
            </Button>
          </Group>
        </Group>
      </Card>

      {/* Node 工具列表 */}
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Title order={3} mb="md">
          <Group gap="xs">
            <IconTool size={20} />
            <Text>Node 工具 ({tools.length})</Text>
          </Group>
        </Title>
        <ScrollArea h={500}>
          <Stack gap="sm">
            {tools.length === 0 ? (
              <Paper p="md" withBorder>
                <Text c="dimmed" ta="center" mb="md">暂无注册的工具</Text>
                <Text size="sm" c="dimmed" ta="center">
                  点击上方"识别设备并注册工具"按钮来扫描 Zigbee 设备并自动生成 MCP 工具
                </Text>
              </Paper>
            ) : (
              tools.map((tool: any, index: number) => (
                <Paper key={tool._id || index} p="md" withBorder>
                  <Group justify="space-between" mb="xs">
                    <Group>
                      <Text fw={600}>{tool.name}</Text>
                      {tool.metadata?.deviceId && (
                        <Badge size="sm" color="blue">
                          设备: {tool.metadata.deviceId}
                        </Badge>
                      )}
                      {tool.metadata?.autoGenerated && (
                        <Badge size="sm" color="green" variant="light">
                          自动生成
                        </Badge>
                      )}
                    </Group>
                    <Group>
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconEdit size={14} />}
                        onClick={() => handleStartEdit(tool)}
                      >
                        编辑描述
                      </Button>
                      <Button size="xs" onClick={() => handleTestTool(tool.name)}>
                        测试
                      </Button>
                    </Group>
                  </Group>
                  
                  {tool.description && (
                    <Text size="sm" c="dimmed" mt="xs" mb="xs">
                      {tool.description}
                    </Text>
                  )}

                  {tool.metadata && (
                    <Group gap="xs" mt="xs">
                      {tool.metadata.deviceName && (
                        <Text size="xs" c="dimmed">
                          设备名称: {tool.metadata.deviceName}
                        </Text>
                      )}
                      {tool.metadata.deviceModel && (
                        <Text size="xs" c="dimmed">
                          型号: {tool.metadata.deviceModel}
                        </Text>
                      )}
                      {tool.metadata.deviceVendor && (
                        <Text size="xs" c="dimmed">
                          厂商: {tool.metadata.deviceVendor}
                        </Text>
                      )}
                    </Group>
                  )}

                  {tool.inputSchema && (
                    <Code block mt="xs" style={{ fontSize: '0.8rem' }}>
                      {JSON.stringify(tool.inputSchema, null, 2)}
                    </Code>
                  )}
                </Paper>
              ))
            )}
          </Stack>
        </ScrollArea>
      </Card>

      {/* 编辑描述弹窗 */}
      <Modal
        opened={editingTool !== null}
        onClose={handleCancelEdit}
        title={`编辑工具描述: ${editingTool}`}
        size="lg"
      >
        <Stack gap="md">
          <Textarea
            label="工具描述"
            placeholder="输入工具描述..."
            value={editDescription}
            onChange={(e) => setEditDescription(e.currentTarget.value)}
            minRows={4}
            autosize
          />
          <Group justify="flex-end">
            <Button
              variant="outline"
              leftSection={<IconX size={16} />}
              onClick={handleCancelEdit}
            >
              取消
            </Button>
            <Button
              leftSection={<IconCheck size={16} />}
              onClick={handleSaveEdit}
              loading={updateToolMutation.isPending}
            >
              保存
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

