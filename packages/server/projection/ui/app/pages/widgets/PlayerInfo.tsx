import { Paper, Stack, Text, Title } from '@mantine/core';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';
import { WidgetConfig } from '../../utils/widgetConfig';
import { getDataFieldValue, formatDisplayText } from '../../utils/widgetTextFields';

interface PlayerInfoProps {
  config?: WidgetConfig;
}

export default function PlayerInfo({ config }: PlayerInfoProps) {
  const { state } = useCs2State();

  const style = config?.style || {};
  const titleConfig = config?.title || {};
  const textConfig = config?.text || {};
  const texts = config?.texts || {};

  // 获取玩家名称
  const playerNameConfig = texts.playerName || {
    dataField: 'player.name',
    displayText: '{value}',
    fallback: '等待 CS2 GSI 数据...',
  };
  const playerNameValue = getDataFieldValue(state, playerNameConfig.dataField || 'player.name');
  const playerNameText = formatDisplayText(
    playerNameConfig.displayText || '{value}',
    playerNameValue,
    playerNameConfig.fallback || '等待 CS2 GSI 数据...'
  );

  // 获取队伍
  const teamConfig = texts.team || {
    dataField: 'player.team',
    displayText: '{value}',
    fallback: '未知阵营',
  };
  const teamValue = getDataFieldValue(state, teamConfig.dataField || 'player.team');
  const teamText = formatDisplayText(
    teamConfig.displayText || '{value}',
    teamValue,
    teamConfig.fallback || '未知阵营'
  );

  return (
    <Paper
      shadow={style.shadow || 'xl'}
      radius={style.borderRadius || 'md'}
      p={style.padding || 'md'}
      withBorder
      style={{
        minWidth: style.minWidth || 200,
        background: style.background || 'rgba(15, 15, 20, 0.74)',
        borderColor: style.borderColor || 'rgba(255, 255, 255, 0.12)',
        backdropFilter: style.backdropFilter || 'blur(12px)',
      }}
    >
      <Stack gap={2}>
        <Title order={titleConfig.order || 3} c={titleConfig.color || 'white'}>
          {playerNameText}
        </Title>
        <Text size={textConfig.size || 'sm'} c={textConfig.color || 'dimmed'}>
          {teamText}
        </Text>
      </Stack>
    </Paper>
  );
}

