import { Box, Group, Paper, Progress, Text, ThemeIcon } from '@mantine/core';
import { IconShield } from '@tabler/icons-react';
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCs2State } from '../../hooks/useCs2State';
import { useEventSystem } from '../../hooks/useEventSystem';
import { WidgetConfig } from '../../utils/widgetConfig';

interface ArmorMoneyProps {
  config?: WidgetConfig;
}

export default function ArmorMoney({ config }: ArmorMoneyProps) {
  // 使用事件系统控制可见性
  const { isVisible } = useEventSystem('armor', true, false);
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  
  const { state } = useCs2State();
  const player = state?.player || {};
  const armor = Number(player?.state?.armor ?? 0);
  const money = Number(player?.state?.money ?? 0);

  const style = config?.style || {};
  
  if (!isVisible && !isPreview) {
    return null;
  }
  const armorProgressConfig = config?.armorProgress || {};
  const iconConfig = config?.icon || {};
  const moneyTextConfig = config?.moneyText || {};

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
      <Group gap="md">
        {config?.showProgress !== false && (
          <Box flex={1}>
            {(config?.showIcon !== false || config?.showText !== false) && (
              <Group gap="xs" mb={4}>
                {config?.showIcon !== false && (
                  <ThemeIcon variant="light" radius="xl" color={iconConfig.color || 'blue'} size={iconConfig.size || 'sm'}>
                    <IconShield size={14} />
                  </ThemeIcon>
                )}
                {config?.showText !== false && (
                  <Text size="xs" c="blue.2" tt="uppercase">
                    Armor {armor}
                  </Text>
                )}
              </Group>
            )}
            {config?.showIcon === true && config?.showText === false && (
              <Box ta="center" mb={4}>
                <ThemeIcon variant="light" radius="xl" color={iconConfig.color || 'blue'} size={iconConfig.size || 'lg'}>
                  <IconShield size={20} />
                </ThemeIcon>
              </Box>
            )}
            {config?.showText === true && config?.showIcon === false && (
              <Box ta="center" mb={4}>
                <Text size="xs" c="blue.2" fw={700}>
                  Armor {armor}
                </Text>
              </Box>
            )}
            <Progress
              value={Math.max(0, Math.min(100, armor))}
              color={armorProgressConfig.color || 'blue'}
              size={armorProgressConfig.size || 'sm'}
              radius={armorProgressConfig.radius || 'xl'}
            />
          </Box>
        )}
        {config?.showProgress === false && config?.showIcon === true && config?.showText === false && (
          <Box ta="center">
            <ThemeIcon variant="light" radius="xl" color={iconConfig.color || 'blue'} size={iconConfig.size || 'lg'}>
              <IconShield size={24} />
            </ThemeIcon>
          </Box>
        )}
        {config?.showProgress === false && config?.showText === true && (
          <Box ta="center">
            <Text size={moneyTextConfig.size || 'md'} c={moneyTextConfig.color || 'yellow'} fw={moneyTextConfig.fw || 700}>
              Armor {armor} | $ {money}
            </Text>
          </Box>
        )}
        {config?.showProgress !== false && (
          <Box>
            <Text size={moneyTextConfig.size || 'xs'} c={moneyTextConfig.color || 'yellow.3'}>
              $ {money}
            </Text>
          </Box>
        )}
      </Group>
    </Paper>
  );
}

