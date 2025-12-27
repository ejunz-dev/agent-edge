import {
  Box, Card, Grid, Group, Stack, Text, Title, Badge, Button, ActionIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconEye, IconSettings, IconCopy } from '@tabler/icons-react';
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { WidgetConfigModal } from '../components/WidgetConfigModal';

// 组件信息配置
const widgetInfo: Record<string, { name: string; description: string; category: string }> = {
  player: { name: '玩家信息', description: '显示当前玩家名称和队伍', category: '玩家' },
  health: { name: '生命值', description: '显示玩家生命值条', category: '玩家' },
  armor: { name: '护甲金钱', description: '显示护甲和金钱信息', category: '玩家' },
  score: { name: '比分', description: '显示双方队伍比分', category: '比赛' },
  bomb: { name: '炸弹状态', description: '显示炸弹状态和倒计时', category: '比赛' },
  weapons: { name: '武器', description: '显示当前持有的武器', category: '玩家' },
  stats: { name: '玩家统计', description: '显示玩家统计数据（击杀/死亡等）', category: '玩家' },
  round: { name: '回合统计', description: '显示回合统计数据', category: '比赛' },
  faceit: { name: 'Faceit 统计', description: '显示 Faceit 玩家统计', category: '比赛' },
  matchteams: { name: '比赛队伍', description: '显示双方队伍信息', category: '比赛' },
  myteam: { name: '我的队伍', description: '显示我方队伍信息', category: '队伍' },
  enemyteam: { name: '敌方队伍', description: '显示敌方队伍信息', category: '队伍' },
  agentstream: { name: 'Agent 流', description: '显示 Agent 生成的文本内容', category: 'Agent' },
  emoji: { name: '表情包', description: '显示 Agent 表情包', category: 'Agent' },
  tts: { name: '语音播放', description: 'TTS 语音播放器', category: 'Agent' },
};

const categories = ['全部', '玩家', '比赛', '队伍', 'Agent'];

export default function WidgetList() {
  const navigate = useNavigate();
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [configModalOpened, setConfigModalOpened] = useState(false);
  const [selectedWidget, setSelectedWidget] = useState<string | null>(null);
  const [previewKeys, setPreviewKeys] = useState<Record<string, number>>({});

  // 监听配置更新事件，刷新预览
  useEffect(() => {
    const handleConfigUpdate = (event: CustomEvent) => {
      const { widgetName } = event.detail;
      // 更新预览 key，强制 iframe 重新加载
      setPreviewKeys((prev) => ({
        ...prev,
        [widgetName]: Date.now(),
      }));
    };

    window.addEventListener('widgetConfigUpdated', handleConfigUpdate as EventListener);
    return () => {
      window.removeEventListener('widgetConfigUpdated', handleConfigUpdate as EventListener);
    };
  }, []);

  const widgets = Object.keys(widgetInfo);
  const filteredWidgets = selectedCategory === '全部'
    ? widgets
    : widgets.filter((key) => widgetInfo[key].category === selectedCategory);

  const handlePreview = (widgetName: string) => {
    window.open(`/widget/${widgetName}?preview=true`, '_blank');
  };

  const handleNavigate = (widgetName: string) => {
    navigate(`/widget/${widgetName}`);
  };

  const handleConfig = (widgetName: string) => {
    setSelectedWidget(widgetName);
    setConfigModalOpened(true);
  };

  const handleCopyUrl = async (widgetName: string) => {
    // 生成完整的 URL，格式为 /widget/{widgetName}
    const baseUrl = window.location.origin;
    const widgetUrl = `${baseUrl}/widget/${widgetName}`;
    
    try {
      await navigator.clipboard.writeText(widgetUrl);
      notifications.show({
        title: '已复制',
        message: `URL 已复制到剪贴板`,
        color: 'green',
      });
    } catch (err) {
      // 降级方案：使用传统方法
      const textArea = document.createElement('textarea');
      textArea.value = widgetUrl;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        notifications.show({
          title: '已复制',
          message: `URL 已复制到剪贴板`,
          color: 'green',
        });
      } catch (e) {
        notifications.show({
          title: '复制失败',
          message: '请手动复制 URL',
          color: 'red',
        });
      }
      document.body.removeChild(textArea);
    }
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>组件列表</Title>
        <Text size="sm" c="dimmed">
          共 {widgets.length} 个组件
        </Text>
      </Group>

      {/* 分类筛选 */}
      <Group gap="xs">
        {categories.map((category) => (
          <Badge
            key={category}
            variant={selectedCategory === category ? 'filled' : 'outline'}
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedCategory(category)}
            size="lg"
          >
            {category}
          </Badge>
        ))}
      </Group>

      {/* 组件网格 */}
      <Grid>
        {filteredWidgets.map((widgetName) => {
          const info = widgetInfo[widgetName];
          const widgetUrl = `/widget/${widgetName}`;

          return (
            <Grid.Col key={widgetName} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
              <Card
                shadow="sm"
                padding="lg"
                radius="md"
                withBorder
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  transition: 'transform 0.2s, box-shadow 0.2s',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-4px)';
                  e.currentTarget.style.boxShadow = '0 8px 16px rgba(0, 0, 0, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '';
                }}
              >
                <Stack gap="md" style={{ flex: 1 }}>
                  {/* 预览区域 */}
                  <Box
                    style={{
                      width: '100%',
                      height: 200,
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      backgroundColor: 'rgba(0, 0, 0, 0.2)',
                      position: 'relative',
                    }}
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
                        key={`preview-${widgetName}-${previewKeys[widgetName] || 0}`}
                        src={`${widgetUrl}?preview=true${previewKeys[widgetName] ? `&t=${previewKeys[widgetName]}` : ''}`}
                        style={{
                          width: '100%',
                          height: '100%',
                          border: 'none',
                          pointerEvents: 'none',
                        }}
                        title={`${info.name} 预览`}
                      />
                    </Box>
                    <Box
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(0, 0, 0, 0.3)',
                        opacity: 0,
                        transition: 'opacity 0.2s',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.opacity = '0';
                      }}
                      onClick={() => handlePreview(widgetName)}
                    >
                      <Button
                        variant="light"
                        leftSection={<IconEye size={16} />}
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePreview(widgetName);
                        }}
                      >
                        预览
                      </Button>
                    </Box>
                  </Box>

                  {/* 组件信息 */}
                  <Stack gap="xs" style={{ flex: 1 }}>
                    <Group justify="space-between" align="flex-start">
                      <Box style={{ flex: 1 }}>
                        <Text fw={600} size="lg" lineClamp={1}>
                          {info.name}
                        </Text>
                        <Text size="sm" c="dimmed" lineClamp={2} mt={4}>
                          {info.description}
                        </Text>
                      </Box>
                      <Badge size="sm" variant="dot">
                        {info.category}
                      </Badge>
                    </Group>

                    <Group gap="xs" align="center">
                      <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1 }}>
                        /widget/{widgetName}
                      </Text>
                      <Tooltip label="复制 URL">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyUrl(widgetName);
                          }}
                        >
                          <IconCopy size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Stack>

                  {/* 操作按钮 */}
                  <Group gap="xs" mt="auto">
                    <Button
                      variant="light"
                      onClick={() => handleConfig(widgetName)}
                      leftSection={<IconSettings size={16} />}
                    >
                      配置
                    </Button>
                    <Button
                      variant="light"
                      flex={1}
                      onClick={() => handleNavigate(widgetName)}
                      rightSection={<IconExternalLink size={16} />}
                    >
                      前往
                    </Button>
                  </Group>
                </Stack>
              </Card>
            </Grid.Col>
          );
        })}
      </Grid>

      {filteredWidgets.length === 0 && (
        <Box ta="center" py="xl">
          <Text c="dimmed">该分类下暂无组件</Text>
        </Box>
      )}

      {/* 配置弹窗 */}
      {selectedWidget && (
        <WidgetConfigModal
          widgetName={selectedWidget}
          widgetDisplayName={widgetInfo[selectedWidget]?.name || selectedWidget}
          opened={configModalOpened}
          onClose={() => {
            setConfigModalOpened(false);
            setSelectedWidget(null);
          }}
        />
      )}
    </Stack>
  );
}

