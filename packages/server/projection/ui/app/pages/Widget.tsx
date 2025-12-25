import { Box } from '@mantine/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import AgentStream from './widgets/AgentStream';
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
import EmojiDisplay from './widgets/EmojiDisplay';
import TTSPlayer from '../components/TTSPlayer';
import { getWidgetConfig, defaultConfigs } from '../utils/widgetConfig';
import { getWidgetStylePreset } from '../utils/widgetStyles';
import { useSearchParams } from 'react-router-dom';
import { useProjectionMessage } from '../hooks/useProjectionWebSocket';

const widgetMap: Record<string, React.ComponentType<any>> = {
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
  agentstream: AgentStream,
  emoji: EmojiDisplay,
  tts: TTSPlayer,
};

// 需要预览模式的组件列表（在预览模式下始终显示，不因数据缺失而隐藏）
const previewModeWidgets = new Set([
  'bomb', 'weapons', 'stats', 'round', 'faceit', 'matchteams', 'myteam', 'enemyteam',
  'player', 'health', 'armor', 'score', 'agentstream', 'emoji', 'tts',
]);

export default function Widget() {
  const { name: routeName } = useParams<{ name: string }>();
  const [searchParams] = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [config, setConfig] = useState<any>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [forceApiReload, setForceApiReload] = useState(false);
  const [forceRefresh, setForceRefresh] = useState(0); // 强制刷新计数器，通过 WebSocket 事件触发

  // 优先使用路由参数，如果没有则使用服务端设置的 widget 名称
  const name = routeName || (typeof window !== 'undefined' ? (window as any).__WIDGET_NAME__ : null);
  const WidgetComponent = name ? widgetMap[name] : null;
  
  // 调试日志
  useEffect(() => {
    console.log('[Widget] 组件渲染:', {
      routeName,
      windowName: typeof window !== 'undefined' ? (window as any).__WIDGET_NAME__ : null,
      finalName: name,
      hasWidgetComponent: !!WidgetComponent,
      pathname: typeof window !== 'undefined' ? window.location.pathname : null,
      hash: typeof window !== 'undefined' ? window.location.hash : null,
    });
  }, [routeName, name, WidgetComponent]);
  
  // 调试日志
  useEffect(() => {
    console.log('[Widget] 组件渲染:', {
      routeName,
      windowName: typeof window !== 'undefined' ? (window as any).__WIDGET_NAME__ : null,
      finalName: name,
      hasWidgetComponent: !!WidgetComponent,
      pathname: typeof window !== 'undefined' ? window.location.pathname : null,
      hash: typeof window !== 'undefined' ? window.location.hash : null,
    });
  }, [routeName, name, WidgetComponent]);
  const isPreview = searchParams.get('preview') === 'true';
  const previewPreset = searchParams.get('preset');

  // 加载组件配置并应用样式预设
  const loadConfig = React.useCallback(async () => {
    if (name) {
      setConfigLoading(true);
      
      // 如果是预览模式，使用临时预设配置
      if (isPreview && previewPreset) {
        const preset = getWidgetStylePreset(name, previewPreset);
        if (preset) {
          console.log(`[Widget] ${name} - 使用预览预设:`, previewPreset);
          setConfig(preset.config);
          setConfigLoading(false);
          return;
        }
      }
      
      // 正常模式，优先使用服务端渲染的配置（除非强制从 API 加载）
      try {
        // 如果强制从 API 加载（配置更新通知触发），跳过服务端配置
        if (!forceApiReload) {
          // 首先检查单个 widget 的配置（从专门的路由 handler 加载）
          if (typeof window !== 'undefined' && (window as any).__WIDGET_NAME__ === name && (window as any).__WIDGET_CONFIG__) {
            console.log(`[Widget] ${name} - 使用专门路由的配置`);
            const serverConfig = (window as any).__WIDGET_CONFIG__;
            
            // 如果有样式预设，应用预设配置
            if (serverConfig.stylePreset) {
              const preset = getWidgetStylePreset(name, serverConfig.stylePreset);
              if (preset) {
                // 合并预设配置和用户配置（用户配置优先）
                const mergedConfig = {
                  ...preset.config,
                  ...serverConfig,
                  style: {
                    ...preset.config.style,
                    ...serverConfig.style,
                  },
                  texts: serverConfig.texts || preset.config.texts || {},
                };
              console.log(`[Widget] ${name} - 合并后的配置:`, mergedConfig);
              setConfig(mergedConfig);
              setConfigLoading(false);
              return;
              }
            }
            console.log(`[Widget] ${name} - 使用专门路由配置（无预设）`);
            setConfig(serverConfig);
            setConfigLoading(false);
            return;
          }
          
          // 其次检查所有 widget 的配置（从通用路由加载）
          if (typeof window !== 'undefined' && (window as any).__WIDGET_CONFIGS__) {
            const serverConfigs = (window as any).__WIDGET_CONFIGS__;
            console.log(`[Widget] ${name} - 检查通用配置是否存在:`, name in serverConfigs);
            if (serverConfigs[name]) {
              console.log(`[Widget] ${name} - 使用服务端渲染的配置`);
              const serverConfig = serverConfigs[name];
              
              // 如果有样式预设，应用预设配置
              if (serverConfig.stylePreset) {
                const preset = getWidgetStylePreset(name, serverConfig.stylePreset);
                if (preset) {
                  // 合并预设配置和用户配置（用户配置优先）
                  const mergedConfig = {
                    ...preset.config,
                    ...serverConfig,
                    style: {
                      ...preset.config.style,
                      ...serverConfig.style,
                    },
                    texts: serverConfig.texts || preset.config.texts || {},
                  };
              console.log(`[Widget] ${name} - 合并后的配置:`, mergedConfig);
              setConfig(mergedConfig);
              setConfigLoading(false);
              return;
                }
              }
              console.log(`[Widget] ${name} - 使用服务端配置（无预设）`);
              setConfig(serverConfig);
              setConfigLoading(false);
              return;
            }
          }
        }
        
        // 如果没有服务端配置或强制从 API 加载，从 API 加载（必须等待完成）
        console.log(`[Widget] ${name} - 从 API 加载配置... (forceApiReload=${forceApiReload})`);
        const widgetConfig = await getWidgetConfig(name);
        console.log(`[Widget] ${name} - 加载的原始配置:`, widgetConfig);
        
        // 如果有样式预设，应用预设配置
        if (widgetConfig.stylePreset) {
          const preset = getWidgetStylePreset(name, widgetConfig.stylePreset);
          if (preset) {
            // 合并预设配置和用户配置（用户配置优先）
            const mergedConfig = {
              ...preset.config,
              ...widgetConfig,
              style: {
                ...preset.config.style,
                ...widgetConfig.style,
              },
              texts: widgetConfig.texts || preset.config.texts || {},
            };
              console.log(`[Widget] ${name} - 合并后的配置:`, mergedConfig);
              setConfig(mergedConfig);
              setConfigLoading(false);
              return;
          }
        }
        console.log(`[Widget] ${name} - 使用原始配置（无预设）`);
        setConfig(widgetConfig);
        setConfigLoading(false);
      } catch (e) {
        console.error(`[Widget] ${name} - 加载配置失败:`, e);
        // 使用默认配置
        setConfig(defaultConfigs[name] || {});
        setConfigLoading(false);
      }
      
      // 重置强制 API 加载标志
      if (forceApiReload) {
        setForceApiReload(false);
      }
    } else {
      setConfigLoading(false);
    }
  }, [name, isPreview, previewPreset, forceApiReload]);

  useEffect(() => {
    console.log(`[Widget] ${name} - 组件挂载，开始加载配置`);
    loadConfig();
  }, [loadConfig]);

  // 监听配置更新事件（CustomEvent，用于同窗口内的通知）
  useEffect(() => {
    const handleConfigUpdate = (event: CustomEvent) => {
      const updatedWidgetName = event.detail?.widgetName;
      if (updatedWidgetName === name) {
        console.log(`[Widget] ${name} - 收到配置更新事件（CustomEvent）`);
        // 延迟一下确保 localStorage 已更新
        setTimeout(() => {
          loadConfig();
        }, 100);
      }
    };

    window.addEventListener('widgetConfigUpdated', handleConfigUpdate as EventListener);
    return () => {
      window.removeEventListener('widgetConfigUpdated', handleConfigUpdate as EventListener);
    };
  }, [name, loadConfig]);

  // 监听 WebSocket 配置更新通知（用于跨窗口通知，如 OBS 浏览器源）
  const handleConfigUpdate = useCallback((data: { widgetName: string } | any) => {
    console.log(`[Widget] ${name} - 收到 WebSocket 消息:`, data);
    // 处理不同的数据格式
    const updatedWidgetName = data?.widgetName || (typeof data === 'object' && data !== null ? data.widgetName : null);
    if (updatedWidgetName === name) {
      console.log(`[Widget] ${name} - 配置更新通知匹配，刷新整个页面`);
      // 延迟一下确保数据库已更新，然后刷新整个页面
      setTimeout(() => {
        window.location.reload();
      }, 300);
    } else {
      console.log(`[Widget] ${name} - 配置更新通知不匹配: 收到=${updatedWidgetName}, 当前=${name}`);
    }
  }, [name]);

  // 监听 config 和 forceRefresh 变化，确保组件重新渲染
  useEffect(() => {
    if (config) {
      console.log(`[Widget] ${name} - 配置已更新，强制刷新计数: ${forceRefresh}, 配置:`, {
        minWidth: config.style?.minWidth,
        padding: config.style?.padding,
        stylePreset: config.stylePreset,
      });
    }
  }, [config, forceRefresh, name]);
  
  useProjectionMessage('widget/config/update', handleConfigUpdate);

  // 定期检查配置更新（用于 OBS 浏览器源，因为可能不会触发事件）
  useEffect(() => {
    if (!name || isPreview) return; // 预览模式不需要定期检查
    
    // 计算当前应该使用的配置字符串（包括预设合并）
    const getCurrentConfigStr = async () => {
      try {
        // 优先使用服务端渲染的配置
        if (typeof window !== 'undefined' && (window as any).__WIDGET_CONFIGS__) {
          const serverConfigs = (window as any).__WIDGET_CONFIGS__;
          if (serverConfigs[name]) {
            const serverConfig = serverConfigs[name];
            if (serverConfig.stylePreset) {
              const preset = getWidgetStylePreset(name, serverConfig.stylePreset);
              if (preset) {
                const merged = {
                  ...preset.config,
                  ...serverConfig,
                  style: {
                    ...preset.config.style,
                    ...serverConfig.style,
                  },
                  texts: serverConfig.texts || preset.config.texts || {},
                };
                return JSON.stringify(merged);
              }
            }
            return JSON.stringify(serverConfig);
          }
        }
        
        const widgetConfig = await getWidgetConfig(name);
        if (widgetConfig.stylePreset) {
          const preset = getWidgetStylePreset(name, widgetConfig.stylePreset);
          if (preset) {
            const merged = {
              ...preset.config,
              ...widgetConfig,
              style: {
                ...preset.config.style,
                ...widgetConfig.style,
              },
              texts: widgetConfig.texts || preset.config.texts || {},
            };
            return JSON.stringify(merged);
          }
        }
        return JSON.stringify(widgetConfig);
      } catch (e) {
        console.error(`[Widget] ${name} - 获取配置失败:`, e);
        return JSON.stringify(config || {});
      }
    };
    
    let lastConfigStr = '';
    getCurrentConfigStr().then(str => { 
      lastConfigStr = str;
      console.log(`[Widget] ${name} - 初始配置字符串长度: ${str.length}`);
    });
    
    const checkInterval = setInterval(async () => {
      // 每 1 秒检查一次配置是否有变化（加快响应速度）
      const currentConfigStr = await getCurrentConfigStr();
      
      if (currentConfigStr !== lastConfigStr) {
        console.log(`[Widget] ${name} - 检测到配置变化，重新加载配置`);
        console.log(`[Widget] ${name} - 旧配置:`, lastConfigStr.substring(0, 200));
        console.log(`[Widget] ${name} - 新配置:`, currentConfigStr.substring(0, 200));
        lastConfigStr = currentConfigStr;
        loadConfig();
      }
    }, 1000); // 改为每 1 秒检查一次

    return () => {
      clearInterval(checkInterval);
    };
  }, [name, isPreview, loadConfig]);

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
        {configLoading || !config ? (
          <Box p="md" c="white" style={{ minWidth: 200, textAlign: 'center' }}>
            加载配置中...
          </Box>
        ) : WidgetComponent ? (
          <WidgetComponent 
            key={`${name}-refresh-${forceRefresh}`} 
            config={config}
          />
        ) : null}
      </div>
    </Box>
  );
}

