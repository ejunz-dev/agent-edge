import {
  Modal, Stack, TextInput, Button, Group, Text, Switch, Card, Title, Box,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import React, { useEffect, useState } from 'react';
import { SceneConfig } from '../pages/SceneList';

// 可用的组件列表
const availableWidgets = [
  { value: 'agentstream', label: 'Agent 流' },
  { value: 'emoji', label: '表情包' },
  { value: 'tts', label: '语音播放' },
  { value: 'myteam', label: '我的队伍' },
  { value: 'enemyteam', label: '敌方队伍' },
  { value: 'matchteams', label: '比赛队伍' },
  { value: 'player', label: '玩家信息' },
  { value: 'health', label: '生命值' },
  { value: 'armor', label: '护甲金钱' },
  { value: 'weapons', label: '武器' },
  { value: 'stats', label: '玩家统计' },
  { value: 'round', label: '回合统计' },
  { value: 'score', label: '比分' },
  { value: 'bomb', label: '炸弹状态' },
  { value: 'faceit', label: 'Faceit 统计' },
];

interface SceneConfigModalProps {
  opened: boolean;
  onClose: () => void;
  scene: SceneConfig | null;
  onSave: () => void;
}

export function SceneConfigModal({
  opened,
  onClose,
  scene,
  onSave,
}: SceneConfigModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm<Omit<SceneConfig, 'id' | 'createdAt' | 'updatedAt'>>({
    initialValues: {
      name: '',
      active: false,
      widgetDefaults: {} as Record<string, boolean>,
    },
  });

  useEffect(() => {
    if (opened) {
      if (scene) {
        // 编辑模式
        form.setValues({
          name: scene.name,
          active: scene.active,
          widgetDefaults: scene.widgetDefaults || {},
        });
      } else {
        // 新建模式，初始化所有组件为默认可见（true）
        const defaults: Record<string, boolean> = {};
        availableWidgets.forEach(widget => {
          defaults[widget.value] = true; // 默认所有组件可见
        });
        form.setValues({
          name: '',
          active: false,
          widgetDefaults: defaults,
        });
      }
    }
  }, [opened, scene]);

  const handleSave = async () => {
    setLoading(true);
    try {
      const url = scene
        ? `/api/projection/scenes/${scene.id}`
        : '/api/projection/scenes';
      const method = scene ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form.values),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '保存失败');
      }

      notifications.show({
        title: '保存成功',
        message: '场景已保存',
        color: 'green',
      });

      onSave();
      onClose();
    } catch (e: any) {
      notifications.show({
        title: '保存失败',
        message: e.message || '无法保存场景',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={scene ? '编辑场景' : '新建场景'}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSave)}>
        <Stack gap="md">
          <TextInput
            label="场景名称"
            placeholder="例如：比赛场景"
            required
            {...form.getInputProps('name')}
          />

          <Box>
            <Title order={5} mb="xs">组件默认状态</Title>
            <Text size="xs" c="dimmed" mb="sm">
              设置该场景下各组件的默认显示/隐藏状态。事件触发后，如果设置了持续时间，会恢复到此默认状态。
            </Text>
            <Stack gap="xs">
              {availableWidgets.map((widget) => (
                <Card key={widget.value} p="sm" withBorder>
                  <Group justify="space-between">
                    <Text size="sm">{widget.label}</Text>
                    <Switch
                      label={form.values.widgetDefaults?.[widget.value] ? '显示' : '隐藏'}
                      checked={form.values.widgetDefaults?.[widget.value] !== false}
                      onChange={(event) => {
                        form.setFieldValue(`widgetDefaults.${widget.value}`, event.currentTarget.checked);
                      }}
                    />
                  </Group>
                </Card>
              ))}
            </Stack>
          </Box>

          <Text size="xs" c="dimmed">
            提示：创建场景后，可以在场景中创建和管理事件。只有激活场景中的事件才会被触发。
          </Text>

          <Group justify="flex-end" mt="md">
            <Button variant="subtle" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" loading={loading}>
              保存
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

