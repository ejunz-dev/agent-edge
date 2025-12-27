import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectionMessage } from './useProjectionWebSocket';

export interface EventAction {
  widgetName: string;
  effect: 'show' | 'hide' | 'toggle';
  duration?: number; // 持续时间（秒），0 或 undefined 表示永久
}

/**
 * Hook: 监听事件系统，控制组件的显示/隐藏
 * @param widgetName 组件名称
 * @param defaultVisible 默认可见性（如果场景有配置，会被覆盖）
 * @param manualControl 是否手动控制可见性（如果为 true，事件系统不会覆盖手动设置）
 */
export function useEventSystem(widgetName: string, defaultVisible: boolean = true, manualControl: boolean = false) {
  // 从场景配置获取默认状态
  const [sceneDefaultVisible, setSceneDefaultVisible] = useState<boolean | null>(null);
  const [isLoadingSceneDefaults, setIsLoadingSceneDefaults] = useState(true);
  // 实际使用的默认状态：优先使用场景配置，否则使用传入的 defaultVisible
  const effectiveDefaultVisible = sceneDefaultVisible !== null ? sceneDefaultVisible : defaultVisible;
  
  // 初始状态：先使用组件默认值，等待场景配置通过 WebSocket 或 API 加载
  // 如果场景配置为隐藏，组件会立即隐藏；如果场景未配置，使用组件默认值
  const [isVisible, setIsVisible] = useState(defaultVisible);
  const timersRef = useRef<Map<string, number>>(new Map());
  const isVisibleRef = useRef(defaultVisible);
  const defaultVisibleRef = useRef(defaultVisible);
  const eventActionRef = useRef<EventAction | null>(null); // 记录当前生效的事件动作
  const sceneConfigReceivedRef = useRef(false); // 标记是否已收到场景配置（通过 WebSocket 或 API）

  // 加载当前激活场景的组件默认状态（作为备用，主要依赖 WebSocket）
  useEffect(() => {
    const loadActiveSceneDefaults = async () => {
      // 如果已经通过 WebSocket 收到场景配置，跳过 API 加载
      if (sceneConfigReceivedRef.current) {
        setIsLoadingSceneDefaults(false);
        return;
      }
      
      setIsLoadingSceneDefaults(true);
      try {
        const response = await fetch('/api/projection/scenes');
        if (response.ok) {
          const data = await response.json();
          const activeScene = data.scenes?.find((s: any) => s.active);
          if (activeScene?.widgetDefaults && typeof activeScene.widgetDefaults[widgetName] === 'boolean') {
            const sceneDefault = activeScene.widgetDefaults[widgetName];
            setSceneDefaultVisible(sceneDefault);
            sceneConfigReceivedRef.current = true;
            console.log(`[EventSystem] ${widgetName} - 📋 从 API 加载场景 "${activeScene.name}" 默认状态: ${sceneDefault}`);
            
            // 立即应用场景默认状态（如果当前没有事件动作生效）
            if (!eventActionRef.current) {
              setIsVisible(sceneDefault);
              isVisibleRef.current = sceneDefault;
              defaultVisibleRef.current = sceneDefault;
              console.log(`[EventSystem] ${widgetName} - ✅ 应用场景默认状态: ${sceneDefault}`);
            }
          } else {
            setSceneDefaultVisible(null);
            sceneConfigReceivedRef.current = true;
            console.log(`[EventSystem] ${widgetName} - 📋 场景未配置默认状态，使用组件默认: ${defaultVisible}`);
            
            // 如果场景未配置，应用组件默认状态
            if (!eventActionRef.current) {
              setIsVisible(defaultVisible);
              isVisibleRef.current = defaultVisible;
              defaultVisibleRef.current = defaultVisible;
            }
          }
        }
      } catch (e) {
        console.error(`[EventSystem] ${widgetName} - ❌ 加载场景默认状态失败:`, e);
        // 加载失败时使用组件默认状态
        if (!eventActionRef.current) {
          setIsVisible(defaultVisible);
          isVisibleRef.current = defaultVisible;
          defaultVisibleRef.current = defaultVisible;
        }
      } finally {
        setIsLoadingSceneDefaults(false);
      }
    };
    
    loadActiveSceneDefaults();
  }, [widgetName, defaultVisible]);

  // 监听场景激活变化（包括 WebSocket 连接建立时的初始推送）
  useProjectionMessage('scene/active/changed', useCallback((data: { sceneId: string; sceneName: string; widgetDefaults: Record<string, boolean> }) => {
    const timestamp = new Date().toLocaleTimeString();
    const sceneDefault = data.widgetDefaults?.[widgetName];
    
    // 标记已收到场景配置（通过 WebSocket）
    sceneConfigReceivedRef.current = true;
    setIsLoadingSceneDefaults(false);
    
    if (typeof sceneDefault === 'boolean') {
      setSceneDefaultVisible(sceneDefault);
      console.log(`[EventSystem] ${widgetName} - 🔄 收到场景配置 (WebSocket): "${data.sceneName}", 默认状态: ${sceneDefault} [${timestamp}]`);
      
      // 立即应用场景默认状态（无论是否有事件动作生效，因为这是初始化）
      setIsVisible(sceneDefault);
      isVisibleRef.current = sceneDefault;
      defaultVisibleRef.current = sceneDefault;
      console.log(`[EventSystem] ${widgetName} - ✅ 应用场景默认状态: ${sceneDefault}`);
    } else {
      setSceneDefaultVisible(null);
      const fallbackDefault = defaultVisible;
      console.log(`[EventSystem] ${widgetName} - 🔄 收到场景配置 (WebSocket): "${data.sceneName}", 未配置默认状态，使用组件默认: ${fallbackDefault} [${timestamp}]`);
      
      // 应用组件默认状态
      setIsVisible(fallbackDefault);
      isVisibleRef.current = fallbackDefault;
      defaultVisibleRef.current = fallbackDefault;
      console.log(`[EventSystem] ${widgetName} - ✅ 应用组件默认状态: ${fallbackDefault}`);
    }
  }, [widgetName, defaultVisible]));

  // 当场景默认状态变化时，更新默认状态引用
  useEffect(() => {
    const newDefault = effectiveDefaultVisible;
    defaultVisibleRef.current = newDefault;
    
    // 如果当前没有事件动作生效，且场景配置已加载完成，应用新的默认状态
    if (!eventActionRef.current && !isLoadingSceneDefaults) {
      setIsVisible(newDefault);
      isVisibleRef.current = newDefault;
      console.log(`[EventSystem] ${widgetName} - 🔄 更新默认状态: ${newDefault} (场景配置: ${sceneDefaultVisible !== null ? sceneDefaultVisible : '未配置'})`);
    }
  }, [effectiveDefaultVisible, isLoadingSceneDefaults, sceneDefaultVisible, widgetName]);
  
  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  // 处理事件动作
  const handleEventAction = useCallback((action: EventAction) => {
    if (manualControl) {
      console.warn(`[EventSystem] ${widgetName} - ⚠️ 事件被忽略（手动控制模式）`, action);
      return; // 如果手动控制，忽略事件
    }

    const timestamp = new Date().toLocaleTimeString();
    const oldVisible = isVisibleRef.current;
    
    console.log(`[EventSystem] ${widgetName} - 📥 收到事件动作 [${timestamp}]`, {
      action,
      currentVisible: oldVisible,
      defaultVisible: defaultVisibleRef.current,
    });

    // 清除之前的定时器
    const existingTimer = timersRef.current.get(action.widgetName);
    if (existingTimer) {
      clearTimeout(existingTimer);
      timersRef.current.delete(action.widgetName);
      console.log(`[EventSystem] ${widgetName} - 🗑️ 清除之前的定时器`);
    }

    // 计算目标状态
    let targetVisible: boolean;
    switch (action.effect) {
      case 'show':
        targetVisible = true; // 目标：显示
        break;
      case 'hide':
        targetVisible = false; // 目标：隐藏
        break;
      case 'toggle':
        targetVisible = !isVisibleRef.current; // 目标：切换后的状态
        break;
      default:
        targetVisible = isVisibleRef.current; // 未知效果，保持当前状态
    }

    // 记录当前生效的事件动作
    eventActionRef.current = action;

    // 确保组件达到目标状态（无论当前状态如何，都强制设置为目标状态）
    // 这样可以确保事件触发后，组件状态与事件配置一致
    const newVisible = targetVisible;
    
    // 强制更新到目标状态（即使状态相同也更新，确保状态一致性）
    setIsVisible(newVisible);
    isVisibleRef.current = newVisible;
    
    if (oldVisible !== newVisible) {
      console.log(`[EventSystem] ${widgetName} - ✅ 状态已更新 [${timestamp}]`, {
        effect: action.effect,
        oldVisible,
        newVisible: targetVisible,
        duration: action.duration ? `${action.duration}秒` : '永久',
      });
    } else {
      console.log(`[EventSystem] ${widgetName} - ✅ 状态已确认（已是目标状态） [${timestamp}]`, {
        effect: action.effect,
        currentVisible: oldVisible,
        targetVisible,
        reason: '确保状态与事件配置一致',
      });
    }

    // 如果有持续时间，设置定时器恢复
    if (action.duration && action.duration > 0) {
      const timer = window.setTimeout(() => {
        // 恢复默认状态
        const restored = defaultVisibleRef.current;
        const restoreTimestamp = new Date().toLocaleTimeString();
        setIsVisible(restored);
        isVisibleRef.current = restored;
        timersRef.current.delete(action.widgetName);
        // 清除事件动作引用，允许场景默认状态生效
        eventActionRef.current = null;
        console.log(`[EventSystem] ${widgetName} - ⏰ 持续时间结束，恢复默认状态 [${restoreTimestamp}]`, {
          restored,
          duration: `${action.duration}秒`,
        });
      }, action.duration * 1000);

      timersRef.current.set(action.widgetName, timer);
      console.log(`[EventSystem] ${widgetName} - ⏱️ 已设置定时器，将在 ${action.duration} 秒后恢复`);
    } else {
      console.log(`[EventSystem] ${widgetName} - ♾️ 永久生效（无持续时间限制）`);
    }
  }, [widgetName, manualControl]);

  // 使用 useProjectionMessage 监听事件
  useProjectionMessage('event/trigger', useCallback((data: { eventId: string; eventName: string; actions: EventAction[] }) => {
    const timestamp = new Date().toLocaleTimeString();
    const matchingAction = data.actions.find(a => a.widgetName === widgetName);
    
    console.log(`[EventSystem] ${widgetName} - 🔔 收到事件触发消息 [${timestamp}]`, {
      eventId: data.eventId,
      eventName: data.eventName,
      totalActions: data.actions.length,
      actions: data.actions.map(a => ({
        widgetName: a.widgetName,
        effect: a.effect,
        duration: a.duration,
      })),
      matchingAction: matchingAction ? '✅ 找到匹配' : '❌ 未找到匹配',
    });
    
    const action = matchingAction;
    if (action) {
      console.log(`[EventSystem] ${widgetName} - ✅ 找到匹配的动作，开始执行 [${timestamp}]`, {
        widgetName: action.widgetName,
        effect: action.effect,
        duration: action.duration,
      });
      handleEventAction(action);
    } else {
      const availableWidgets = data.actions.map(a => a.widgetName).join(', ');
      console.log(`[EventSystem] ${widgetName} - ❌ 没有找到匹配的动作 [${timestamp}]`, {
        expected: widgetName,
        available: availableWidgets || '无',
        reason: availableWidgets ? `事件中的组件列表不包含 "${widgetName}"` : '事件中没有动作',
      });
    }
  }, [widgetName, handleEventAction]));

  // 清理定时器
  useEffect(() => {
    return () => {
      timersRef.current.forEach(timer => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  return { isVisible, setIsVisible };
}

