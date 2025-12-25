// 文字配置：数据字段映射和显示文本
export interface TextConfig {
  dataField?: string; // 数据字段路径，如 'player.name', 'map.team_t.score'
  displayText?: string; // 显示文本模板，可以使用 {value} 占位符
  fallback?: string; // 数据为空时的默认文本
}

// 组件配置类型定义
export interface WidgetConfig {
  // 样式预设ID
  stylePreset?: string;
  // 通用样式配置
  style?: {
    minWidth?: number;
    minHeight?: number;
    width?: number;
    height?: number;
    padding?: string;
    background?: string;
    borderColor?: string;
    border?: string;
    backdropFilter?: string;
    borderRadius?: string;
    shadow?: string;
    maxWidth?: number;
  };
  // 文字配置（字段名 -> 文字配置）
  texts?: Record<string, TextConfig>;
  // 组件特定配置
  [key: string]: any;
}

// 所有组件的配置类型
export type WidgetConfigs = Record<string, WidgetConfig>;

// 默认配置
export const defaultConfigs: WidgetConfigs = {
  player: {
    stylePreset: 'default',
    style: {
      minWidth: 200,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
    title: {
      order: 3,
      color: 'white',
    },
    text: {
      size: 'sm',
      color: 'dimmed',
    },
  },
  health: {
    stylePreset: 'default',
    style: {
      minWidth: 280,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
    progress: {
      color: 'red',
      size: 'lg',
      radius: 'xl',
    },
    icon: {
      color: 'red',
      size: 'sm',
    },
    text: {
      size: 'xs',
      color: 'red.2',
    },
  },
  armor: {
    stylePreset: 'default',
    style: {
      minWidth: 280,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
    armorProgress: {
      color: 'blue',
      size: 'sm',
      radius: 'xl',
    },
    icon: {
      color: 'blue',
      size: 'sm',
    },
    moneyText: {
      size: 'xs',
      color: 'yellow.3',
    },
  },
  score: {
    stylePreset: 'default',
    style: {
      minWidth: 180,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
    tColor: 'yellow',
    ctColor: 'cyan',
    textSize: 'sm',
  },
  bomb: {
    style: {
      minWidth: 200,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  weapons: {
    style: {
      minWidth: 200,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  stats: {
    style: {
      minWidth: 200,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  round: {
    style: {
      minWidth: 200,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  faceit: {
    style: {
      minWidth: 300,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  matchteams: {
    style: {
      minWidth: 400,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  myteam: {
    style: {
      minWidth: 300,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  enemyteam: {
    style: {
      minWidth: 300,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
  },
  agentstream: {
    style: {
      minWidth: 400,
      maxWidth: 800,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
    text: {
      size: 'md',
      color: 'white',
    },
    liveTimeout: 10000, // 10秒
  },
  emoji: {
    style: {
      width: 200,
      height: 200,
      minWidth: 200,
      minHeight: 200,
    },
    size: 200,
    liveTimeout: 10000, // 10秒
  },
  tts: {
    style: {
      minWidth: 300,
      background: 'rgba(15, 15, 20, 0.74)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(12px)',
      padding: 'md',
      borderRadius: 'md',
      shadow: 'xl',
    },
    size: 'md',
    showProgress: true,
  },
};

// 从后端 API 加载配置
export async function loadWidgetConfigs(): Promise<WidgetConfigs> {
  try {
    const response = await fetch('/api/projection/widget-config');
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.configs) {
        // 合并默认配置，确保新字段有默认值
        const merged: WidgetConfigs = {};
        for (const [key, defaultConfig] of Object.entries(defaultConfigs)) {
          merged[key] = {
            ...defaultConfig,
            ...(data.configs[key] || {}),
            style: {
              ...defaultConfig.style,
              ...(data.configs[key]?.style || {}),
            },
          };
        }
        return merged;
      }
    }
  } catch (e) {
    console.error('从后端加载组件配置失败:', e);
    // 降级到 localStorage
    try {
      const stored = localStorage.getItem('widgetConfigs');
      if (stored) {
        const parsed = JSON.parse(stored);
        const merged: WidgetConfigs = {};
        for (const [key, defaultConfig] of Object.entries(defaultConfigs)) {
          merged[key] = {
            ...defaultConfig,
            ...(parsed[key] || {}),
            style: {
              ...defaultConfig.style,
              ...(parsed[key]?.style || {}),
            },
          };
        }
        return merged;
      }
    } catch (e2) {
      console.error('从 localStorage 加载组件配置失败:', e2);
    }
  }
  return { ...defaultConfigs };
}

// 同步版本（用于向后兼容）
export function loadWidgetConfigsSync(): WidgetConfigs {
  try {
    const stored = localStorage.getItem('widgetConfigs');
    if (stored) {
      const parsed = JSON.parse(stored);
      const merged: WidgetConfigs = {};
      for (const [key, defaultConfig] of Object.entries(defaultConfigs)) {
        merged[key] = {
          ...defaultConfig,
          ...(parsed[key] || {}),
          style: {
            ...defaultConfig.style,
            ...(parsed[key]?.style || {}),
          },
        };
      }
      return merged;
    }
  } catch (e) {
    console.error('加载组件配置失败:', e);
  }
  return { ...defaultConfigs };
}

// 保存配置到后端 API
export async function saveWidgetConfigs(configs: WidgetConfigs): Promise<void> {
  try {
    // 保存所有配置到后端
    for (const [widgetName, config] of Object.entries(configs)) {
      await fetch('/api/projection/widget-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widgetName, config }),
      });
    }
    // 同时保存到 localStorage 作为备份
    try {
      localStorage.setItem('widgetConfigs', JSON.stringify(configs));
    } catch (e) {
      console.warn('保存到 localStorage 失败:', e);
    }
  } catch (e) {
    console.error('保存组件配置到后端失败:', e);
    // 降级到 localStorage
    try {
      localStorage.setItem('widgetConfigs', JSON.stringify(configs));
    } catch (e2) {
      console.error('保存组件配置失败:', e2);
    }
  }
}

// 获取单个组件的配置（异步版本）
export async function getWidgetConfig(widgetName: string): Promise<WidgetConfig> {
  // 优先使用服务端渲染的配置（如果存在）
  if (typeof window !== 'undefined' && (window as any).__WIDGET_CONFIGS__) {
    const serverConfigs = (window as any).__WIDGET_CONFIGS__;
    if (serverConfigs[widgetName]) {
      console.log(`[widgetConfig] ${widgetName} - 使用服务端渲染的配置`);
      const serverConfig = serverConfigs[widgetName];
      // 合并默认配置
      const defaultConfig = defaultConfigs[widgetName] || {};
      return {
        ...defaultConfig,
        ...serverConfig,
        style: {
          ...defaultConfig.style,
          ...(serverConfig.style || {}),
        },
      };
    }
  }
  
  try {
    const response = await fetch(`/api/projection/widget-config?widgetName=${encodeURIComponent(widgetName)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.config) {
        // 合并默认配置
        const defaultConfig = defaultConfigs[widgetName] || {};
        return {
          ...defaultConfig,
          ...data.config,
          style: {
            ...defaultConfig.style,
            ...(data.config.style || {}),
          },
        };
      }
    }
  } catch (e) {
    console.error(`获取组件配置失败 (${widgetName}):`, e);
  }
  // 降级到同步版本
  return getWidgetConfigSync(widgetName);
}

// 获取单个组件的配置（同步版本，用于向后兼容）
export function getWidgetConfigSync(widgetName: string): WidgetConfig {
  const configs = loadWidgetConfigsSync();
  return configs[widgetName] || defaultConfigs[widgetName] || {};
}

// 更新单个组件的配置（异步版本）
export async function updateWidgetConfig(widgetName: string, config: Partial<WidgetConfig>): Promise<void> {
  try {
    // 先获取现有配置
    const existingConfig = await getWidgetConfig(widgetName);
    
    console.log(`[widgetConfig] ${widgetName} - 更新前配置:`, existingConfig);
    console.log(`[widgetConfig] ${widgetName} - 新配置数据:`, config);
    
    // 合并配置，确保所有字段都被保存
    const updatedConfig: WidgetConfig = {
      ...existingConfig,
      // 先应用所有非嵌套字段
      ...Object.keys(config).reduce((acc, key) => {
        if (key !== 'style' && key !== 'texts') {
          acc[key] = config[key as keyof WidgetConfig];
        }
        return acc;
      }, {} as any),
      // 合并 style 对象（用户配置优先）
      style: {
        ...(existingConfig.style || {}),
        ...(config.style || {}),
      },
      // 合并 texts 对象（用户配置优先）
      texts: {
        ...(existingConfig.texts || {}),
        ...(config.texts || {}),
      },
    };
    
    console.log(`[widgetConfig] ${widgetName} - 合并后的配置:`, updatedConfig);
    
    // 保存到后端
    console.log(`[widgetConfig] ${widgetName} - 发送保存请求:`, { widgetName, configSize: JSON.stringify(updatedConfig).length });
    const response = await fetch('/api/projection/widget-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widgetName, config: updatedConfig }),
    });
    
    console.log(`[widgetConfig] ${widgetName} - 响应状态: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      let errorText = '';
      try {
        errorText = await response.text();
        // 尝试解析为 JSON
        try {
          const errorJson = JSON.parse(errorText);
          errorText = errorJson.error || errorText;
        } catch {
          // 不是 JSON，使用原始文本
        }
      } catch (e) {
        errorText = `无法读取错误信息: ${(e as Error).message}`;
      }
      console.error(`[widgetConfig] ${widgetName} - 保存失败，响应状态: ${response.status}, 错误: ${errorText}`);
      throw new Error(`保存失败 (${response.status}): ${errorText}`);
    }
    
    let result;
    try {
      const responseText = await response.text();
      console.log(`[widgetConfig] ${widgetName} - 响应文本:`, responseText);
      if (!responseText) {
        console.warn(`[widgetConfig] ${widgetName} - 响应为空，假设保存成功`);
        // 如果响应为空，假设保存成功（某些框架可能不返回内容）
        return;
      }
      result = JSON.parse(responseText);
      console.log(`[widgetConfig] ${widgetName} - 保存响应:`, result);
    } catch (e) {
      console.error(`[widgetConfig] ${widgetName} - 解析响应失败:`, e);
      // 如果响应是 200 但无法解析，可能是空响应，假设保存成功
      if (response.status === 200) {
        console.warn(`[widgetConfig] ${widgetName} - 响应 200 但无法解析，假设保存成功`);
        return;
      }
      throw new Error(`解析响应失败: ${(e as Error).message}`);
    }
    
    // 检查 result 是否存在 success 字段
    if (result && typeof result === 'object') {
      if (result.success === false) {
        throw new Error(result.error || '保存失败');
      }
      // 如果 success 是 true 或 undefined，继续执行
      if (result.success === true) {
        console.log(`[widgetConfig] ${widgetName} - 保存成功确认`);
      }
    } else {
      // result 不是对象，可能是其他格式，假设保存成功
      console.warn(`[widgetConfig] ${widgetName} - 响应格式异常，但状态码 200，假设保存成功`);
    }
    
    // 等待一下确保数据库写入完成
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // 验证保存是否成功
    const savedConfig = await getWidgetConfig(widgetName);
    console.log(`[widgetConfig] ${widgetName} - 保存后的配置:`, savedConfig);
    console.log(`[widgetConfig] ${widgetName} - 期望的 stylePreset: ${config.stylePreset}, 实际的 stylePreset: ${savedConfig.stylePreset}`);
    
    // 验证关键字段
    if (config.stylePreset && savedConfig.stylePreset !== config.stylePreset) {
      console.error(`[widgetConfig] ${widgetName} - 警告: stylePreset 保存失败! 期望: ${config.stylePreset}, 实际: ${savedConfig.stylePreset}`);
      // 如果保存失败，重试一次
      console.log(`[widgetConfig] ${widgetName} - 重试保存配置...`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryConfig = await getWidgetConfig(widgetName);
      if (retryConfig.stylePreset !== config.stylePreset) {
        console.error(`[widgetConfig] ${widgetName} - 重试后仍然失败，期望: ${config.stylePreset}, 实际: ${retryConfig.stylePreset}`);
      } else {
        console.log(`[widgetConfig] ${widgetName} - 重试后成功，配置已更新`);
      }
    }
    if (config.style && JSON.stringify(savedConfig.style) !== JSON.stringify(updatedConfig.style)) {
      console.error(`[widgetConfig] ${widgetName} - 警告: style 保存可能不完整!`);
    }
  } catch (e) {
    console.error(`[widgetConfig] ${widgetName} - 保存配置失败:`, e);
    throw e;
  }
}

// 重置单个组件的配置为默认值
export async function resetWidgetConfig(widgetName: string): Promise<void> {
  const defaultConfig = defaultConfigs[widgetName] || {};
  await updateWidgetConfig(widgetName, defaultConfig);
}

// 重置所有配置为默认值
export function resetAllWidgetConfigs(): void {
  saveWidgetConfigs({ ...defaultConfigs });
}

