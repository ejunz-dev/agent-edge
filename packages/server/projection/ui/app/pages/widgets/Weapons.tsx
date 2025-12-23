import { Group, Paper, Stack, Text } from '@mantine/core';
import React from 'react';
import { useCs2State } from '../../hooks/useCs2State';

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

export default function Weapons() {
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

  return (
    <Paper
      shadow="xl"
      radius="md"
      p="md"
      withBorder
      style={{
        minWidth: 240,
        background: 'rgba(15, 15, 20, 0.74)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <Stack gap={4}>
        <InfoRow label="当前武器" value={activeWeaponText} />
        <InfoRow label="副武器" value={secondaryWeaponText} />
        <InfoRow label="道具" value={grenadeSummary} />
      </Stack>
    </Paper>
  );
}

