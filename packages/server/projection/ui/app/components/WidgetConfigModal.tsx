import {
  Modal, Stack, TextInput, NumberInput, ColorInput, Select, Button, Group, Tabs, Text, Switch, Card, Badge, Box,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import React, { useEffect, useState } from 'react';
import { WidgetConfig, getWidgetConfig, updateWidgetConfig, resetWidgetConfig } from '../utils/widgetConfig';
import { getWidgetStylePresets, getWidgetStylePreset } from '../utils/widgetStyles';
import { getWidgetTextFields, TextFieldDefinition } from '../utils/widgetTextFields';

interface WidgetConfigModalProps {
  widgetName: string;
  widgetDisplayName: string;
  opened: boolean;
  onClose: () => void;
}

export function WidgetConfigModal({
  widgetName,
  widgetDisplayName,
  opened,
  onClose,
}: WidgetConfigModalProps) {
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const stylePresets = getWidgetStylePresets(widgetName);
  const textFields = getWidgetTextFields(widgetName);
  
  const form = useForm<WidgetConfig>({
    initialValues: {
      stylePreset: 'default',
      texts: {},
    },
  });

  useEffect(() => {
    if (opened) {
      getWidgetConfig(widgetName).then((currentConfig) => {
        setConfig(currentConfig);
        form.setValues({
          ...currentConfig,
          stylePreset: currentConfig.stylePreset || 'default',
          texts: currentConfig.texts || {},
        });
      });
    }
  }, [opened, widgetName]);

  // 应用样式预设
  const handlePresetChange = (presetId: string) => {
    const preset = getWidgetStylePreset(widgetName, presetId);
    if (preset) {
      form.setFieldValue('stylePreset', presetId);
      // 合并预设配置，保留用户自定义的文字配置
      const newConfig = {
        ...preset.config,
        stylePreset: presetId,
        texts: form.values.texts || {},
      };
      form.setValues(newConfig);
    }
  };

  const handleSave = async () => {
    console.log(`[WidgetConfigModal] ${widgetName} - 保存配置:`, form.values);
    try {
      await updateWidgetConfig(widgetName, form.values);
      // 验证保存是否成功
      const savedConfig = await getWidgetConfig(widgetName);
      console.log(`[WidgetConfigModal] ${widgetName} - 保存后的配置:`, savedConfig);
      // 触发自定义事件，通知 WidgetList 刷新预览
      window.dispatchEvent(new CustomEvent('widgetConfigUpdated', {
        detail: { widgetName },
      }));
      onClose();
    } catch (e: any) {
      console.error(`[WidgetConfigModal] ${widgetName} - 保存失败:`, e);
      const errorMessage = e?.message || e?.toString() || '未知错误';
      console.error(`[WidgetConfigModal] ${widgetName} - 错误详情:`, errorMessage);
      alert(`保存配置失败: ${errorMessage}\n\n请查看浏览器控制台获取更多信息。`);
    }
  };

  const handleReset = () => {
    resetWidgetConfig(widgetName);
    const defaultConfig = getWidgetConfig(widgetName);
    form.setValues({
      ...defaultConfig,
      stylePreset: 'default',
      texts: {},
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`配置组件: ${widgetDisplayName}`}
      size="lg"
    >
      <form onSubmit={form.onSubmit(handleSave)}>
        <Tabs defaultValue="preset">
          <Tabs.List>
            <Tabs.Tab value="preset">样式预设</Tabs.Tab>
            <Tabs.Tab value="texts">文字配置</Tabs.Tab>
            <Tabs.Tab value="style">样式细节</Tabs.Tab>
            <Tabs.Tab value="advanced">高级</Tabs.Tab>
          </Tabs.List>

          {/* 样式预设选择 */}
          <Tabs.Panel value="preset" pt="md">
            <Stack gap="md">
              <Text size="sm" c="dimmed">
                选择一个样式预设作为起点，然后可以在其他标签页中进一步自定义
              </Text>
              <Stack gap="sm">
                {stylePresets.map((preset) => {
                  const isSelected = form.values.stylePreset === preset.id;
                  // 构建预览 URL，使用临时配置参数
                  const previewUrl = `/widget/${widgetName}?preview=true&preset=${preset.id}&t=${Date.now()}`;
                  
                  return (
                    <Card
                      key={preset.id}
                      padding="md"
                      withBorder
                      style={{
                        cursor: 'pointer',
                        borderColor: isSelected
                          ? 'var(--mantine-color-blue-6)'
                          : undefined,
                        backgroundColor: isSelected
                          ? 'var(--mantine-color-blue-0)'
                          : undefined,
                      }}
                      onClick={() => handlePresetChange(preset.id)}
                    >
                      <Stack gap="sm">
                        <Group justify="space-between">
                          <Stack gap={4}>
                            <Group gap="xs">
                              <Text fw={600}>{preset.name}</Text>
                              {isSelected && (
                                <Badge size="sm" color="blue">已选择</Badge>
                              )}
                            </Group>
                            {preset.description && (
                              <Text size="sm" c="dimmed">
                                {preset.description}
                              </Text>
                            )}
                          </Stack>
                        </Group>
                        
                        {/* 预览区域 */}
                        <Box
                          style={{
                            width: '100%',
                            height: 150,
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            overflow: 'hidden',
                            backgroundColor: 'rgba(0, 0, 0, 0.2)',
                            position: 'relative',
                            marginTop: '8px',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Box
                            style={{
                              width: '200%',
                              height: '200%',
                              transform: 'scale(0.5)',
                              transformOrigin: 'top left',
                              position: 'relative',
                            }}
                          >
                            <iframe
                              key={`preview-${preset.id}-${isSelected ? 'selected' : ''}`}
                              src={previewUrl}
                              style={{
                                width: '100%',
                                height: '100%',
                                border: 'none',
                                pointerEvents: 'none',
                              }}
                              title={`${preset.name} 预览`}
                            />
                          </Box>
                        </Box>
                      </Stack>
                    </Card>
                  );
                })}
              </Stack>
            </Stack>
          </Tabs.Panel>

          {/* 文字配置 */}
          <Tabs.Panel value="texts" pt="md">
            <Stack gap="md">
              {textFields.length > 0 ? (
                textFields.map((field: TextFieldDefinition) => {
                  const textConfig = form.values.texts?.[field.key] || {
                    dataField: field.dataField,
                    displayText: field.defaultDisplayText,
                    fallback: field.fallback,
                  };
                  
                  return (
                    <Card key={field.key} padding="md" withBorder>
                      <Stack gap="sm">
                        <Text fw={600}>{field.label}</Text>
                        {field.description && (
                          <Text size="xs" c="dimmed">
                            {field.description}
                          </Text>
                        )}
                        <TextInput
                          label="数据字段路径"
                          placeholder="例如: player.name"
                          description="从CS2 GSI数据中获取值的路径"
                          value={textConfig.dataField || ''}
                          onChange={(e) => {
                            const newTexts = {
                              ...(form.values.texts || {}),
                              [field.key]: {
                                ...textConfig,
                                dataField: e.target.value,
                              },
                            };
                            form.setFieldValue('texts', newTexts);
                          }}
                        />
                        <TextInput
                          label="显示文本模板"
                          placeholder="例如: 玩家: {value}"
                          description="使用 {value} 作为数据值的占位符"
                          value={textConfig.displayText || ''}
                          onChange={(e) => {
                            const newTexts = {
                              ...(form.values.texts || {}),
                              [field.key]: {
                                ...textConfig,
                                displayText: e.target.value,
                              },
                            };
                            form.setFieldValue('texts', newTexts);
                          }}
                        />
                        <TextInput
                          label="默认文本（数据为空时）"
                          placeholder="例如: 未知"
                          value={textConfig.fallback || ''}
                          onChange={(e) => {
                            const newTexts = {
                              ...(form.values.texts || {}),
                              [field.key]: {
                                ...textConfig,
                                fallback: e.target.value,
                              },
                            };
                            form.setFieldValue('texts', newTexts);
                          }}
                        />
                      </Stack>
                    </Card>
                  );
                })
              ) : (
                <Text c="dimmed" size="sm">
                  该组件暂无可配置的文字字段
                </Text>
              )}
            </Stack>
          </Tabs.Panel>

          {/* 样式细节 */}
          <Tabs.Panel value="style" pt="md">
            <Stack gap="md">
              <Group grow>
                <NumberInput
                  label="最小宽度"
                  {...form.getInputProps('style.minWidth')}
                  min={0}
                />
                <NumberInput
                  label="最小高度"
                  {...form.getInputProps('style.minHeight')}
                  min={0}
                />
              </Group>
              <Group grow>
                <NumberInput
                  label="宽度"
                  {...form.getInputProps('style.width')}
                  min={0}
                />
                <NumberInput
                  label="高度"
                  {...form.getInputProps('style.height')}
                  min={0}
                />
              </Group>
              <NumberInput
                label="最大宽度"
                {...form.getInputProps('style.maxWidth')}
                min={0}
              />
              <Select
                label="内边距"
                data={['xs', 'sm', 'md', 'lg', 'xl']}
                {...form.getInputProps('style.padding')}
              />
              <ColorInput
                label="背景颜色"
                format="rgba"
                {...form.getInputProps('style.background')}
              />
              <ColorInput
                label="边框颜色"
                format="rgba"
                {...form.getInputProps('style.borderColor')}
              />
              <TextInput
                label="背景模糊"
                placeholder="blur(12px)"
                {...form.getInputProps('style.backdropFilter')}
              />
              <Select
                label="圆角"
                data={['xs', 'sm', 'md', 'lg', 'xl']}
                {...form.getInputProps('style.borderRadius')}
              />
              <Select
                label="阴影"
                data={['xs', 'sm', 'md', 'lg', 'xl']}
                {...form.getInputProps('style.shadow')}
              />
              
              {/* 组件特定样式配置 */}
              {widgetName === 'health' && (
                <>
                  <Select
                    label="进度条颜色"
                    data={['red', 'blue', 'green', 'yellow', 'orange', 'purple']}
                    {...form.getInputProps('progress.color')}
                  />
                  <Select
                    label="进度条大小"
                    data={['xs', 'sm', 'md', 'lg', 'xl']}
                    {...form.getInputProps('progress.size')}
                  />
                </>
              )}
              {widgetName === 'armor' && (
                <>
                  <Select
                    label="护甲进度条颜色"
                    data={['red', 'blue', 'green', 'yellow', 'orange', 'purple']}
                    {...form.getInputProps('armorProgress.color')}
                  />
                  <ColorInput
                    label="金钱文字颜色"
                    format="rgba"
                    {...form.getInputProps('moneyText.color')}
                  />
                </>
              )}
              {widgetName === 'score' && (
                <>
                  <ColorInput
                    label="T 队颜色"
                    format="rgba"
                    {...form.getInputProps('tColor')}
                  />
                  <ColorInput
                    label="CT 队颜色"
                    format="rgba"
                    {...form.getInputProps('ctColor')}
                  />
                </>
              )}
              {widgetName === 'agentstream' && (
                <NumberInput
                  label="Live 阶段超时时间（毫秒）"
                  {...form.getInputProps('liveTimeout')}
                  min={0}
                />
              )}
              {widgetName === 'emoji' && (
                <>
                  <NumberInput
                    label="表情包大小"
                    {...form.getInputProps('size')}
                    min={50}
                    max={500}
                  />
                  <NumberInput
                    label="Live 阶段超时时间（毫秒）"
                    {...form.getInputProps('liveTimeout')}
                    min={0}
                  />
                </>
              )}
              {widgetName === 'tts' && (
                <>
                  <Select
                    label="大小"
                    data={['sm', 'md', 'lg']}
                    {...form.getInputProps('size')}
                  />
                  <Switch
                    label="显示进度条"
                    {...form.getInputProps('showProgress', { type: 'checkbox' })}
                  />
                </>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="advanced" pt="md">
            <Stack gap="md">
              <Text c="dimmed" size="sm">
                高级配置选项将根据组件类型动态显示
              </Text>
            </Stack>
          </Tabs.Panel>
        </Tabs>

        <Group justify="flex-end" mt="xl">
          <Button variant="outline" onClick={handleReset}>
            重置为默认值
          </Button>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit">
            保存
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
