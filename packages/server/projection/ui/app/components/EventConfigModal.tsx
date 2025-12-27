import {
  Modal, Stack, TextInput, Select, Button, Group, Text, Switch, ActionIcon, Box, NumberInput, Card,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { EventConfig } from '../pages/EventList';

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

// 常用的 GSI 字段路径
const commonGSIFields = [
  { value: 'round.phase', label: '回合阶段 (round.phase)' },
  { value: 'round.round', label: '回合数 (round.round)' },
  { value: 'player.state.health', label: '玩家生命值 (player.state.health)' },
  { value: 'player.state.armor', label: '玩家护甲 (player.state.armor)' },
  { value: 'player.state.money', label: '玩家金钱 (player.state.money)' },
  { value: 'player.team', label: '玩家队伍 (player.team)' },
  { value: 'bomb.state', label: '炸弹状态 (bomb.state)' },
  { value: 'map.phase', label: '地图阶段 (map.phase)' },
  { value: 'map.team_ct.score', label: 'CT 队伍得分 (map.team_ct.score)' },
  { value: 'map.team_t.score', label: 'T 队伍得分 (map.team_t.score)' },
];

interface EventConfigModalProps {
  opened: boolean;
  onClose: () => void;
  event: EventConfig | null;
  sceneId?: string; // 创建事件时必须提供场景 ID
  onSave: () => void;
}

export function EventConfigModal({
  opened,
  onClose,
  event,
  sceneId,
  onSave,
}: EventConfigModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm<Omit<EventConfig, 'id' | 'createdAt' | 'updatedAt'>>({
    initialValues: {
      sceneId: sceneId || '',
      name: '',
      enabled: true,
      trigger: {
        field: 'round.phase',
        operator: 'equals',
        value: 'live',
      },
      actions: [
        {
          widgetName: 'agentstream',
          effect: 'hide',
          duration: 10,
        },
      ],
    },
  });

  useEffect(() => {
    if (opened) {
      if (event) {
        // 编辑模式
        form.setValues({
          sceneId: event.sceneId,
          name: event.name,
          enabled: event.enabled,
          trigger: event.trigger,
          actions: event.actions,
        });
      } else {
        // 新建模式
        if (!sceneId) {
          notifications.show({
            title: '错误',
            message: '创建事件时必须指定场景',
            color: 'red',
          });
          onClose();
          return;
        }
        form.setValues({
          sceneId: sceneId,
          name: '',
          enabled: true,
          trigger: {
            field: 'round.phase',
            operator: 'equals',
            value: 'live',
          },
          actions: [
            {
              widgetName: 'agentstream',
              effect: 'hide',
              duration: 10,
            },
          ],
        });
      }
    }
  }, [opened, event, sceneId, onClose]);

  const handleSave = async () => {
    if (!event && !sceneId) {
      notifications.show({
        title: '错误',
        message: '创建事件时必须指定场景',
        color: 'red',
      });
      return;
    }

    setLoading(true);
    try {
      const url = event
        ? `/api/projection/events/${event.id}`
        : '/api/projection/events';
      const method = event ? 'PUT' : 'POST';

      // 创建事件时必须包含 sceneId
      const body = event
        ? form.values
        : { ...form.values, sceneId };

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '保存失败');
      }

      notifications.show({
        title: '保存成功',
        message: '事件已保存',
        color: 'green',
      });

      onSave();
      onClose();
    } catch (e: any) {
      notifications.show({
        title: '保存失败',
        message: e.message || '无法保存事件',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const addAction = () => {
    form.insertListItem('actions', {
      widgetName: 'agentstream',
      effect: 'hide',
      duration: 10,
    });
  };

  const removeAction = (index: number) => {
    form.removeListItem('actions', index);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={event ? '编辑事件' : '新建事件'}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSave)}>
        <Stack gap="md">
          <TextInput
            label="事件名称"
            placeholder="例如：Live 阶段隐藏 Agent 流"
            required
            {...form.getInputProps('name')}
          />

          <Switch
            label="启用事件"
            {...form.getInputProps('enabled', { type: 'checkbox' })}
          />

          <Box>
            <Text size="sm" fw={600} mb="xs">触发条件</Text>
            <Stack gap="sm">
              <Select
                label="GSI 字段路径"
                placeholder="选择字段路径"
                data={commonGSIFields}
                searchable
                {...form.getInputProps('trigger.field')}
              />

              <Select
                label="操作符"
                data={[
                  { value: 'equals', label: '等于' },
                  { value: 'not_equals', label: '不等于' },
                  { value: 'greater_than', label: '大于' },
                  { value: 'less_than', label: '小于' },
                  { value: 'contains', label: '包含' },
                ]}
                {...form.getInputProps('trigger.operator')}
              />

              <TextInput
                label="比较值"
                placeholder="例如：live, 100, CT"
                {...form.getInputProps('trigger.value')}
              />
            </Stack>
          </Box>

          <Box>
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={600}>动作</Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlus size={14} />}
                onClick={addAction}
              >
                添加动作
              </Button>
            </Group>

            <Stack gap="sm">
              {form.values.actions.map((action, index) => (
                <Card key={index} padding="sm" withBorder>
                  <Stack gap="sm">
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>动作 {index + 1}</Text>
                      {form.values.actions.length > 1 && (
                        <ActionIcon
                          color="red"
                          variant="light"
                          onClick={() => removeAction(index)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      )}
                    </Group>

                    <Select
                      label="目标组件"
                      data={availableWidgets}
                      {...form.getInputProps(`actions.${index}.widgetName`)}
                    />

                    <Select
                      label="效果"
                      data={[
                        { value: 'show', label: '显示' },
                        { value: 'hide', label: '隐藏' },
                        { value: 'toggle', label: '切换' },
                      ]}
                      {...form.getInputProps(`actions.${index}.effect`)}
                    />

                    <NumberInput
                      label="持续时间（秒）"
                      description="0 表示永久，留空也表示永久"
                      min={0}
                      placeholder="例如：10"
                      {...form.getInputProps(`actions.${index}.duration`)}
                    />
                  </Stack>
                </Card>
              ))}
            </Stack>
          </Box>

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

