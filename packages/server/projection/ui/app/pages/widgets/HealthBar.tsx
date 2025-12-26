import { Box, Group, Paper, Progress, Text, ThemeIcon } from '@mantine/core';
import { IconSword } from '@tabler/icons-react';
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCs2State } from '../../hooks/useCs2State';
import { useEventSystem } from '../../hooks/useEventSystem';
import { WidgetConfig } from '../../utils/widgetConfig';
import { getDataFieldValue, formatDisplayText } from '../../utils/widgetTextFields';

interface HealthBarProps {
  config?: WidgetConfig;
}

export default function HealthBar({ config }: HealthBarProps) {
  // 使用事件系统控制可见性
  const { isVisible } = useEventSystem('health', true, false);
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  
  const { state } = useCs2State();
  const hp = Number(getDataFieldValue(state, 'player.state.health') ?? 0);

  const style = config?.style || {};
  const progressConfig = config?.progress || {};
  const iconConfig = config?.icon || {};
  const textConfig = config?.text || {};
  const texts = config?.texts || {};

  // 获取HP标签文本
  const hpLabelConfig = texts.hpLabel || {
    dataField: 'player.state.health',
    displayText: 'HP {value}',
    fallback: 'HP 0',
  };
  const hpValue = getDataFieldValue(state, hpLabelConfig.dataField || 'player.state.health');
  const hpLabelText = formatDisplayText(
    hpLabelConfig.displayText || 'HP {value}',
    hpValue,
    hpLabelConfig.fallback || 'HP 0'
  );

  if (!isVisible && !isPreview) {
    return null;
  }

  return (
    <Paper
      shadow={style.shadow || 'xl'}
      radius={style.borderRadius || 'md'}
      p={style.padding || 'md'}
      withBorder
      style={{
        minWidth: style.minWidth || 280,
        background: style.background || 'rgba(15, 15, 20, 0.74)',
        borderColor: style.borderColor || 'rgba(255, 255, 255, 0.12)',
        backdropFilter: style.backdropFilter || 'blur(12px)',
      }}
    >
      <Box>
        {(config?.showIcon !== false) && (config?.showText !== false) && (
          <Group gap="xs" mb={config?.showProgress !== false ? 4 : 0}>
            {config?.showIcon !== false && (
              <ThemeIcon variant="light" radius="xl" color={iconConfig.color || 'red'} size={iconConfig.size || 'sm'}>
                <IconSword size={14} />
              </ThemeIcon>
            )}
            {config?.showText !== false && (
              <Text size={textConfig.size || 'xs'} c={textConfig.color || 'red.2'} tt="uppercase">
                {hpLabelText}
              </Text>
            )}
          </Group>
        )}
        {config?.showIcon === true && config?.showText === false && (
          <Box ta="center" mb={config?.showProgress !== false ? 4 : 0}>
            <ThemeIcon variant="light" radius="xl" color={iconConfig.color || 'red'} size={iconConfig.size || 'lg'}>
              <IconSword size={20} />
            </ThemeIcon>
          </Box>
        )}
        {config?.showText === true && config?.showIcon === false && (
          <Box ta="center" mb={config?.showProgress !== false ? 4 : 0}>
            <Text size={textConfig.size || 'md'} c={textConfig.color || 'red'} fw={textConfig.fw || 700}>
              {hpLabelText}
            </Text>
          </Box>
        )}
        {config?.showProgress !== false && (
          <Progress
            value={Math.max(0, Math.min(100, hp))}
            color={progressConfig.color || 'red'}
            size={progressConfig.size || 'lg'}
            radius={progressConfig.radius || 'xl'}
          />
        )}
      </Box>
    </Paper>
  );
}

