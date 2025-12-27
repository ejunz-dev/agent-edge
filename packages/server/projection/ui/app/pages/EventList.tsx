import {
  Box, Button, Card, Grid, Group, Stack, Text, Title, Badge, ActionIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconEdit, IconTrash, IconPlay } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';
import { EventConfigModal } from '../components/EventConfigModal';

export interface EventConfig {
  id: string;
  sceneId: string; // 事件所属的场景 ID
  name: string;
  enabled: boolean;
  trigger: {
    field: string; // GSI 字段路径，如 "round.phase"
    operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains';
    value: any;
  };
  actions: Array<{
    widgetName: string; // 组件名称
    effect: 'show' | 'hide' | 'toggle'; // 效果
    duration?: number; // 持续时间（秒），0 表示永久
  }>;
  createdAt: number;
  updatedAt: number;
}

export default function EventList() {
  const [events, setEvents] = useState<EventConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [configModalOpened, setConfigModalOpened] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<EventConfig | null>(null);

  // 加载事件列表
  const loadEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/projection/events');
      if (response.ok) {
        const data = await response.json();
        setEvents(data.events || []);
      }
    } catch (e) {
      console.error('加载事件列表失败:', e);
      notifications.show({
        title: '加载失败',
        message: '无法加载事件列表',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
  }, []);

  const handleCreate = () => {
    setSelectedEvent(null);
    setConfigModalOpened(true);
  };

  const handleEdit = (event: EventConfig) => {
    setSelectedEvent(event);
    setConfigModalOpened(true);
  };

  const handleDelete = async (eventId: string) => {
    if (!confirm('确定要删除这个事件吗？')) return;

    try {
      const response = await fetch(`/api/projection/events/${eventId}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        notifications.show({
          title: '删除成功',
          message: '事件已删除',
          color: 'green',
        });
        loadEvents();
      } else {
        throw new Error('删除失败');
      }
    } catch (e) {
      notifications.show({
        title: '删除失败',
        message: '无法删除事件',
        color: 'red',
      });
    }
  };

  const handleSave = () => {
    setConfigModalOpened(false);
    loadEvents();
  };

  const formatTrigger = (trigger: EventConfig['trigger']) => {
    const operatorMap = {
      equals: '等于',
      not_equals: '不等于',
      greater_than: '大于',
      less_than: '小于',
      contains: '包含',
    };
    return `${trigger.field} ${operatorMap[trigger.operator]} ${JSON.stringify(trigger.value)}`;
  };

  const formatActions = (actions: EventConfig['actions']) => {
    return actions.map((action) => {
      const effectMap = {
        show: '显示',
        hide: '隐藏',
        toggle: '切换',
      };
      const duration = action.duration ? `${action.duration}秒` : '永久';
      return `${action.widgetName} - ${effectMap[action.effect]} (${duration})`;
    }).join(', ');
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>事件列表</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={handleCreate}
        >
          新建事件
        </Button>
      </Group>

      {loading ? (
        <Text c="dimmed">加载中...</Text>
      ) : events.length === 0 ? (
        <Card p="xl" ta="center">
          <Text c="dimmed" mb="md">还没有创建任何事件</Text>
          <Button onClick={handleCreate}>创建第一个事件</Button>
        </Card>
      ) : (
        <Grid>
          {events.map((event) => (
            <Grid.Col key={event.id} span={{ base: 12, md: 6, lg: 4 }}>
              <Card shadow="sm" padding="lg" radius="md" withBorder>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Group gap="xs">
                      <Title order={4}>{event.name}</Title>
                      {event.enabled ? (
                        <Badge color="green">已启用</Badge>
                      ) : (
                        <Badge color="gray">已禁用</Badge>
                      )}
                    </Group>
                    <Group gap="xs">
                      <Tooltip label="编辑">
                        <ActionIcon
                          variant="light"
                          onClick={() => handleEdit(event)}
                        >
                          <IconEdit size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="删除">
                        <ActionIcon
                          variant="light"
                          color="red"
                          onClick={() => handleDelete(event.id)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Group>

                  <Box>
                    <Text size="sm" fw={600} mb={4}>触发条件:</Text>
                    <Text size="sm" c="dimmed">{formatTrigger(event.trigger)}</Text>
                  </Box>

                  <Box>
                    <Text size="sm" fw={600} mb={4}>动作:</Text>
                    <Text size="sm" c="dimmed">{formatActions(event.actions)}</Text>
                  </Box>

                  <Text size="xs" c="dimmed">
                    更新于: {new Date(event.updatedAt).toLocaleString()}
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>
          ))}
        </Grid>
      )}

      <EventConfigModal
        opened={configModalOpened}
        onClose={() => setConfigModalOpened(false)}
        event={selectedEvent}
        onSave={handleSave}
      />
    </Stack>
  );
}

