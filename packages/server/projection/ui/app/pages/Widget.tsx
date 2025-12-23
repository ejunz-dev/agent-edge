import { Box } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import ArmorMoney from './widgets/ArmorMoney';
import BombStatus from './widgets/BombStatus';
import EnemyTeam from './widgets/EnemyTeam';
import FaceitStats from './widgets/FaceitStats';
import HealthBar from './widgets/HealthBar';
import MatchTeams from './widgets/MatchTeams';
import MyTeam from './widgets/MyTeam';
import PlayerInfo from './widgets/PlayerInfo';
import PlayerStats from './widgets/PlayerStats';
import RoundStats from './widgets/RoundStats';
import Score from './widgets/Score';
import Weapons from './widgets/Weapons';

const widgetMap: Record<string, React.ComponentType> = {
  player: PlayerInfo,
  health: HealthBar,
  armor: ArmorMoney,
  score: Score,
  bomb: BombStatus,
  weapons: Weapons,
  stats: PlayerStats,
  round: RoundStats,
  faceit: FaceitStats,
  matchteams: MatchTeams,
  myteam: MyTeam,
  enemyteam: EnemyTeam,
};

export default function Widget() {
  const { name } = useParams<{ name: string }>();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const WidgetComponent = name ? widgetMap[name] : null;

  // 计算缩放比例，让组件填满窗口的 90%
  useEffect(() => {
    const updateScale = () => {
      if (!containerRef.current || !contentRef.current) return;

      const container = containerRef.current;
      const content = contentRef.current;

      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      const contentWidth = content.scrollWidth;
      const contentHeight = content.scrollHeight;

      if (contentWidth === 0 || contentHeight === 0) {
        // 如果内容还没渲染，延迟一下再计算
        setTimeout(updateScale, 100);
        return;
      }

      // 计算缩放比例，留 10% 边距
      const scaleX = (containerWidth * 0.9) / contentWidth;
      const scaleY = (containerHeight * 0.9) / contentHeight;
      const newScale = Math.min(scaleX, scaleY, 10); // 最大不超过 10 倍

      setScale(newScale);
    };

    updateScale();
    window.addEventListener('resize', updateScale);

    // 延迟一下确保内容已渲染
    const timer = setTimeout(updateScale, 200);

    return () => {
      window.removeEventListener('resize', updateScale);
      clearTimeout(timer);
    };
  }, [name]);

  if (!WidgetComponent) {
    return (
      <Box p="md" c="white">
        未知组件: {name}
        <br />
        可用组件: {Object.keys(widgetMap).join(', ')}
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        boxSizing: 'border-box',
        backgroundColor: 'transparent',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <div
        ref={contentRef}
        style={{
          pointerEvents: 'auto',
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          transition: 'transform 0.2s ease-out',
        }}
      >
        <WidgetComponent />
      </div>
    </Box>
  );
}

