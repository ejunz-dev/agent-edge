import { Group, Paper, Stack, Text } from '@mantine/core';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';
import { WidgetConfig } from '../../utils/widgetConfig';
import { getDataFieldValue, formatDisplayText } from '../../utils/widgetTextFields';

interface ScoreProps {
  config?: WidgetConfig;
}

export default function Score({ config }: ScoreProps) {
  const { state } = useCs2State();

  const style = config?.style || {};
  const textSize = config?.textSize || 'sm';
  const tColor = config?.tColor || 'yellow';
  const ctColor = config?.ctColor || 'cyan';
  const texts = config?.texts || {};

  // 获取地图名称
  const mapNameConfig = texts.mapName || {
    dataField: 'map.name',
    displayText: '{value}',
    fallback: '未知地图',
  };
  const mapNameValue = getDataFieldValue(state, mapNameConfig.dataField || 'map.name');
  const mapNameText = formatDisplayText(
    mapNameConfig.displayText || '{value}',
    mapNameValue,
    mapNameConfig.fallback || '未知地图'
  );

  // 获取T队比分
  const tScoreConfig = texts.tScore || {
    dataField: 'map.team_t.score',
    displayText: 'T {value}',
    fallback: 'T 0',
  };
  const tScoreValue = getDataFieldValue(state, tScoreConfig.dataField || 'map.team_t.score');
  const tScoreText = formatDisplayText(
    tScoreConfig.displayText || 'T {value}',
    tScoreValue,
    tScoreConfig.fallback || 'T 0'
  );

  // 获取CT队比分
  const ctScoreConfig = texts.ctScore || {
    dataField: 'map.team_ct.score',
    displayText: 'CT {value}',
    fallback: 'CT 0',
  };
  const ctScoreValue = getDataFieldValue(state, ctScoreConfig.dataField || 'map.team_ct.score');
  const ctScoreText = formatDisplayText(
    ctScoreConfig.displayText || 'CT {value}',
    ctScoreValue,
    ctScoreConfig.fallback || 'CT 0'
  );

  return (
    <Paper
      shadow={style.shadow || 'xl'}
      radius={style.borderRadius || 'md'}
      p={style.padding || 'md'}
      withBorder
      style={{
        minWidth: style.minWidth || 180,
        background: style.background || 'rgba(15, 15, 20, 0.74)',
        borderColor: style.borderColor || 'rgba(255, 255, 255, 0.12)',
        backdropFilter: style.backdropFilter || 'blur(12px)',
      }}
    >
      <Stack gap={2} align="flex-end">
        {config?.showMapName !== false && (
          <Text size={textSize} c="dimmed">
            {mapNameText}
          </Text>
        )}
        {config?.showScore !== false && (
          <Group gap="xs">
            <Text size={textSize} c={tColor}>
              {tScoreText}
            </Text>
            <Text size={textSize} c="dimmed">
              :
            </Text>
            <Text size={textSize} c={ctColor}>
              {ctScoreText}
            </Text>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

