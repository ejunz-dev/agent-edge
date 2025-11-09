import {
  Badge, Button, Card, Code, Group, Paper, ScrollArea, Stack, Switch, Text, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

export default function MCPTools() {
  const queryClient = useQueryClient();

  const { data: toolsData, refetch: refetchTools } = useQuery({
    queryKey: ['provider_tools'],
    queryFn: () => fetch('/api/tools').then((res) => res.json()),
    refetchInterval: 5000,
  });

  const updateToolMutation = useMutation({
    mutationFn: async ({ tool, enabled, description }: { tool: string; enabled?: boolean; description?: string }) => {
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, enabled, description }),
      });
      if (!res.ok) throw new Error('Failed to update tool');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider_tools'] });
      notifications.show({
        title: '成功',
        message: '工具配置已更新',
        color: 'green',
      });
    },
    onError: () => {
      notifications.show({
        title: '错误',
        message: '更新工具配置失败',
        color: 'red',
      });
    },
  });

  const handleTestTool = async (toolName: string) => {
    try {
      const res = await fetch('/mcp/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: {},
          },
          id: 1,
        }),
      });
      const result = await res.json();
      if (result.result) {
        notifications.show({
          title: '成功',
          message: `工具 ${toolName} 调用成功`,
          color: 'green',
        });
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

  const handleToggleTool = (toolName: string, enabled: boolean) => {
    updateToolMutation.mutate({ tool: toolName, enabled });
  };

  return (
    <Stack gap="md">
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Title order={2} mb="md">MCP 工具配置</Title>
        <ScrollArea h={500}>
          <Stack gap="sm">
            {toolsData?.tools?.map((tool: any, index: number) => (
              <Paper key={tool.name || index} p="md" withBorder>
                <Group justify="space-between" mb="xs">
                  <Group>
                    <Text fw={500}>{tool.name}</Text>
                    <Badge color={tool.enabled ? 'green' : 'red'}>
                      {tool.enabled ? '已启用' : '已禁用'}
                    </Badge>
                  </Group>
                  <Group>
                    <Switch
                      checked={tool.enabled}
                      onChange={(e) => handleToggleTool(tool.name, e.currentTarget.checked)}
                      label="启用"
                    />
                    <Button size="xs" onClick={() => handleTestTool(tool.name)}>
                      测试
                    </Button>
                  </Group>
                </Group>
                {tool.description && (
                  <Text size="sm" c="dimmed" mt="xs">
                    {tool.description}
                  </Text>
                )}
              </Paper>
            ))}
          </Stack>
        </ScrollArea>
      </Card>
    </Stack>
  );
}

