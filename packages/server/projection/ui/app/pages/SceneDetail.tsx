import {
  Box, Button, Card, Group, Stack, Text, Title, Badge, ActionIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconEdit, IconTrash, IconCheck, IconBolt, IconArrowLeft } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SceneConfigModal } from '../components/SceneConfigModal';
import { EventConfigModal } from '../components/EventConfigModal';
import { EventConfig } from './EventList';

export interface SceneConfig {
  id: string;
  name: string;
  active: boolean;
  widgetDefaults?: Record<string, boolean>; // 组件默认状态配置
  createdAt: number;
  updatedAt: number;
}

export default function SceneDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [scene, setScene] = useState<SceneConfig | null>(null);
  const [events, setEvents] = useState<EventConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [sceneModalOpened, setSceneModalOpened] = useState(false);
  const [eventModalOpened, setEventModalOpened] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<EventConfig | null>(null);

  // 加载场景详情
  const loadScene = async () => {
    if (!id) return;
    try {
      setLoading(true);
      const response = await fetch(`/api/projection/scenes/${id}`);
      if (response.ok) {
        const data = await response.json();
        setScene(data.scene || null);
      } else {
        notifications.show({
          title: '加载失败',
          message: '无法加载场景详情',
          color: 'red',
        });
        navigate('/scenes');
      }
    } catch (e) {
      console.error('加载场景详情失败:', e);
      notifications.show({
        title: '加载失败',
        message: '无法加载场景详情',
        color: 'red',
      });
      navigate('/scenes');
    } finally {
      setLoading(false);
    }
  };

  // 加载场景中的事件
  const loadEvents = async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/projection/events?sceneId=${id}`);
      if (response.ok) {
        const data = await response.json();
        setEvents(data.events || []);
      }
    } catch (e) {
      console.error('加载场景事件失败:', e);
    }
  };

  useEffect(() => {
    loadScene();
    loadEvents();
  }, [id]);

  const handleActivate = async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/projection/scenes/${id}/activate`, {
        method: 'POST',
      });
      if (response.ok) {
        notifications.show({
          title: '激活成功',
          message: '场景已激活',
          color: 'green',
        });
        loadScene();
      } else {
        throw new Error('激活失败');
      }
    } catch (e) {
      notifications.show({
        title: '激活失败',
        message: '无法激活场景',
        color: 'red',
      });
    }
  };

  const handleEditScene = () => {
    setSceneModalOpened(true);
  };

  const handleDeleteScene = async () => {
    if (!id || !confirm('确定要删除这个场景吗？删除场景会同时删除场景中的所有事件。')) return;

    try {
      const response = await fetch(`/api/projection/scenes/${id}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        notifications.show({
          title: '删除成功',
          message: '场景已删除',
          color: 'green',
        });
        navigate('/scenes');
      } else {
        throw new Error('删除失败');
      }
    } catch (e) {
      notifications.show({
        title: '删除失败',
        message: '无法删除场景',
        color: 'red',
      });
    }
  };

  const handleCreateEvent = () => {
    setSelectedEvent(null);
    setEventModalOpened(true);
  };

  const handleEditEvent = (event: EventConfig) => {
    setSelectedEvent(event);
    setEventModalOpened(true);
  };

  const handleDeleteEvent = async (eventId: string) => {
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

  const handleSceneSave = () => {
    setSceneModalOpened(false);
    loadScene();
  };

  const handleEventSave = () => {
    setEventModalOpened(false);
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

  if (loading) {
    return <Text c="dimmed">加载中...</Text>;
  }

  if (!scene) {
    return (
      <Stack gap="md">
        <Text c="dimmed">场景不存在</Text>
        <Button onClick={() => navigate('/scenes')}>返回场景列表</Button>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Group gap="md">
          <ActionIcon
            variant="light"
            onClick={() => navigate('/scenes')}
          >
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Title order={2}>{scene.name}</Title>
          {scene.active ? (
            <Badge color="green">已激活</Badge>
          ) : (
            <Badge color="gray">未激活</Badge>
          )}
        </Group>
        <Group gap="xs">
          {!scene.active && (
            <Button
              variant="light"
              color="green"
              leftSection={<IconCheck size={16} />}
              onClick={handleActivate}
            >
              激活场景
            </Button>
          )}
          <Button
            variant="light"
            leftSection={<IconEdit size={16} />}
            onClick={handleEditScene}
          >
            编辑场景
          </Button>
          <Button
            variant="light"
            color="red"
            leftSection={<IconTrash size={16} />}
            onClick={handleDeleteScene}
          >
            删除场景
          </Button>
        </Group>
      </Group>

      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Stack gap="md">
          <Group justify="space-between">
            <Group gap="xs">
              <IconBolt size={20} />
              <Title order={3}>事件列表</Title>
              <Badge variant="light">{events.length} 个事件</Badge>
            </Group>
            <Button
              size="sm"
              leftSection={<IconPlus size={16} />}
              onClick={handleCreateEvent}
            >
              新建事件
            </Button>
          </Group>

          {events.length === 0 ? (
            <Card p="md" withBorder style={{ background: 'rgba(0,0,0,0.1)' }}>
              <Text size="sm" c="dimmed" ta="center" mb="md">
                该场景中还没有事件
              </Text>
              <Button
                size="sm"
                variant="light"
                fullWidth
                leftSection={<IconPlus size={14} />}
                onClick={handleCreateEvent}
              >
                创建第一个事件
              </Button>
            </Card>
          ) : (
            <Stack gap="xs">
              {events.map((event) => (
                <Card key={event.id} p="sm" withBorder style={{ background: 'rgba(0,0,0,0.05)' }}>
                  <Group justify="space-between">
                    <Group gap="xs">
                      <IconBolt size={16} />
                      <Box>
                        <Group gap="xs">
                          <Text size="sm" fw={600}>{event.name}</Text>
                          {event.enabled ? (
                            <Badge size="xs" color="green">已启用</Badge>
                          ) : (
                            <Badge size="xs" color="gray">已禁用</Badge>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed" mt={4}>
                          触发: {formatTrigger(event.trigger)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          动作: {event.actions.map(a => {
                            const effectMap = { show: '显示', hide: '隐藏', toggle: '切换' };
                            const duration = a.duration ? `${a.duration}秒` : '永久';
                            return `${a.widgetName} - ${effectMap[a.effect]} (${duration})`;
                          }).join(', ')}
                        </Text>
                      </Box>
                    </Group>
                    <Group gap="xs">
                      <Tooltip label="编辑">
                        <ActionIcon
                          size="sm"
                          variant="light"
                          onClick={() => handleEditEvent(event)}
                        >
                          <IconEdit size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="删除">
                        <ActionIcon
                          size="sm"
                          variant="light"
                          color="red"
                          onClick={() => handleDeleteEvent(event.id)}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Group>
                </Card>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>

      <SceneConfigModal
        opened={sceneModalOpened}
        onClose={() => setSceneModalOpened(false)}
        scene={scene}
        onSave={handleSceneSave}
      />

      <EventConfigModal
        opened={eventModalOpened}
        onClose={() => setEventModalOpened(false)}
        event={selectedEvent}
        sceneId={selectedEvent?.sceneId || scene.id}
        onSave={handleEventSave}
      />
    </Stack>
  );
}

