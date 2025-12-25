import { Group, Paper, Stack, Text } from '@mantine/core';
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCs2State } from '../../hooks/useCs2State';
import { WidgetConfig } from '../../utils/widgetConfig';

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </Group>
  );
}

interface WeaponsProps {
  config?: WidgetConfig;
}

export default function Weapons({ config }: WeaponsProps) {
  // 调试日志：组件渲染
  React.useEffect(() => {
    console.log('[Weapons] 组件渲染，配置:', {
      minWidth: config?.style?.minWidth,
      padding: config?.style?.padding,
      stylePreset: config?.stylePreset,
      showIcon: config?.showIcon,
      showText: config?.showText,
    });
  }, [config]);

  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const { state } = useCs2State();
  const player = state?.player || {};
  const weapons = player?.weapons || {};

  const weaponList = Object.values(weapons).filter((w: any) => w && w.name) as any[];
  const activeWeapon = weaponList.find((w) => w.state === 'active') || null;
  const primaryWeapon = weaponList.find((w) => ['Rifle', 'SniperRifle', 'SubmachineGun', 'Shotgun', 'MachineGun'].includes(w?.type)) || null;
  const secondaryWeapon = weaponList.find((w) => w?.type === 'Pistol') || null;
  const grenades = weaponList.filter((w) => w?.type === 'Grenade');

  function formatWeapon(w: any | null) {
    if (!w) return '无';
    const name = w.name || '未知';
    if (typeof w.ammo_clip === 'number') {
      const reserve = typeof w.ammo_reserve === 'number' ? w.ammo_reserve : 0;
      return `${name} ${w.ammo_clip}/${reserve}`;
    }
    return name;
  }

  const activeWeaponText = formatWeapon(activeWeapon || primaryWeapon);
  const secondaryWeaponText = formatWeapon(secondaryWeapon);

  const grenadeSummary = (() => {
    if (!grenades.length) return '无';
    const mapCount = new Map<string, number>();
    grenades.forEach((g) => {
      const n = g.name || 'Grenade';
      mapCount.set(n, (mapCount.get(n) || 0) + 1);
    });
    return Array.from(mapCount.entries())
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
      .join(' / ');
  })();

  const style = config?.style || {};

  // 构建样式对象，避免 border 和 borderColor 冲突
  const paperStyle: React.CSSProperties = {
    minWidth: style.minWidth || 240,
    background: style.background || 'rgba(15, 15, 20, 0.74)',
    backdropFilter: style.backdropFilter || 'blur(12px)',
  };

  // 如果设置了完整的 border，使用它；否则使用 borderColor
  if (style.border) {
    paperStyle.border = style.border;
  } else {
    paperStyle.borderColor = style.borderColor || 'rgba(255, 255, 255, 0.12)';
  }

  return (
    <Paper
      shadow={style.shadow || 'xl'}
      radius={style.borderRadius || 'md'}
      p={style.padding || 'md'}
      withBorder={!style.border} // 如果设置了自定义 border，不使用 withBorder
      style={paperStyle}
    >
      <Stack gap={4}>
        {config?.showText !== false && (
          <>
            <InfoRow label={config?.showIcon === false ? "" : "当前武器"} value={isPreview ? 'AK-47 30/90' : activeWeaponText} />
            <InfoRow label={config?.showIcon === false ? "" : "副武器"} value={isPreview ? 'Glock-18 20/120' : secondaryWeaponText} />
            <InfoRow label={config?.showIcon === false ? "" : "道具"} value={isPreview ? 'HE Grenade / Flashbang x2' : grenadeSummary} />
          </>
        )}
        {config?.showText === false && config?.showIcon === true && (
          <Group gap="xs">
            <Text size="lg">🔫</Text>
            <Text size="lg">🔫</Text>
            <Text size="lg">💣</Text>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

