import {
  Box, Button, Card, Grid, Group, Stack, Text, Title, Badge, ActionIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconCheck, IconArrowRight } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SceneConfigModal } from '../components/SceneConfigModal';

export interface SceneConfig {
  id: string;
  name: string;
  active: boolean;
  widgetDefaults?: Record<string, boolean>; // 组件默认状态配置
  createdAt: number;
  updatedAt: number;
}

export default function SceneList() {
  const navigate = useNavigate();
  const [scenes, setScenes] = useState<SceneConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [sceneModalOpened, setSceneModalOpened] = useState(false);
  const [selectedScene, setSelectedScene] = useState<SceneConfig | null>(null);

  // 加载场景列表
  const loadScenes = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/projection/scenes');
      if (response.ok) {
        const data = await response.json();
        setScenes(data.scenes || []);
      }
    } catch (e) {
      console.error('加载场景列表失败:', e);
      notifications.show({
        title: '加载失败',
        message: '无法加载场景列表',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScenes();
  }, []);

  const handleCreateScene = () => {
    setSelectedScene(null);
    setSceneModalOpened(true);
  };

  const handleActivate = async (sceneId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止跳转
    try {
      const response = await fetch(`/api/projection/scenes/${sceneId}/activate`, {
        method: 'POST',
      });
      if (response.ok) {
        notifications.show({
          title: '激活成功',
          message: '场景已激活',
          color: 'green',
        });
        loadScenes();
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

  const handleSceneSave = () => {
    setSceneModalOpened(false);
    loadScenes();
  };

  const handleSceneClick = (sceneId: string) => {
    navigate(`/scenes/${sceneId}`);
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>场景管理</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={handleCreateScene}
        >
          新建场景
        </Button>
      </Group>

      {loading ? (
        <Text c="dimmed">加载中...</Text>
      ) : scenes.length === 0 ? (
        <Card p="xl" ta="center">
          <Text c="dimmed" mb="md">还没有创建任何场景</Text>
          <Button onClick={handleCreateScene}>创建第一个场景</Button>
        </Card>
      ) : (
        <Grid>
          {scenes.map((scene) => (
            <Grid.Col key={scene.id} span={{ base: 12, md: 6, lg: 4 }}>
              <Card
                shadow="sm"
                padding="lg"
                radius="md"
                withBorder
                style={{ cursor: 'pointer' }}
                onClick={() => handleSceneClick(scene.id)}
              >
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Group gap="xs">
                      <Title order={4}>{scene.name}</Title>
                      {scene.active ? (
                        <Badge color="green">已激活</Badge>
                      ) : (
                        <Badge color="gray">未激活</Badge>
                      )}
                    </Group>
                    <Group gap="xs" onClick={(e) => e.stopPropagation()}>
                      {!scene.active && (
                        <Tooltip label="激活场景">
                          <ActionIcon
                            variant="light"
                            color="green"
                            onClick={(e) => handleActivate(scene.id, e)}
                          >
                            <IconCheck size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      <Tooltip label="前往详情">
                        <ActionIcon
                          variant="light"
                          onClick={() => handleSceneClick(scene.id)}
                        >
                          <IconArrowRight size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Group>

                  <Text size="xs" c="dimmed">
                    更新于: {new Date(scene.updatedAt).toLocaleString()}
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>
          ))}
        </Grid>
      )}

      <SceneConfigModal
        opened={sceneModalOpened}
        onClose={() => setSceneModalOpened(false)}
        scene={selectedScene}
        onSave={handleSceneSave}
      />
    </Stack>
  );
}
