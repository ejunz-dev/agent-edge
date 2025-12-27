// 组件可配置的文字字段定义
export interface TextFieldDefinition {
  key: string; // 配置中的key
  label: string; // 显示标签
  dataField: string; // 默认数据字段路径
  defaultDisplayText: string; // 默认显示文本模板
  fallback?: string; // 默认fallback文本
  description?: string; // 字段描述
}

// 每个组件的可配置文字字段
export const widgetTextFields: Record<string, TextFieldDefinition[]> = {
  player: [
    {
      key: 'playerName',
      label: '玩家名称',
      dataField: 'player.name',
      defaultDisplayText: '{value}',
      fallback: '等待 CS2 GSI 数据...',
      description: '显示玩家名称',
    },
    {
      key: 'team',
      label: '队伍',
      dataField: 'player.team',
      defaultDisplayText: '{value}',
      fallback: '未知阵营',
      description: '显示玩家队伍',
    },
  ],
  health: [
    {
      key: 'hpLabel',
      label: '生命值标签',
      dataField: 'player.state.health',
      defaultDisplayText: 'HP {value}',
      fallback: 'HP 0',
      description: '显示生命值文本',
    },
  ],
  armor: [
    {
      key: 'armorLabel',
      label: '护甲标签',
      dataField: 'player.state.armor',
      defaultDisplayText: 'Armor {value}',
      fallback: 'Armor 0',
      description: '显示护甲文本',
    },
    {
      key: 'moneyLabel',
      label: '金钱标签',
      dataField: 'player.state.money',
      defaultDisplayText: '$ {value}',
      fallback: '$ 0',
      description: '显示金钱文本',
    },
  ],
  score: [
    {
      key: 'mapName',
      label: '地图名称',
      dataField: 'map.name',
      defaultDisplayText: '{value}',
      fallback: '未知地图',
      description: '显示地图名称',
    },
    {
      key: 'tScore',
      label: 'T队比分',
      dataField: 'map.team_t.score',
      defaultDisplayText: 'T {value}',
      fallback: 'T 0',
      description: '显示T队比分',
    },
    {
      key: 'ctScore',
      label: 'CT队比分',
      dataField: 'map.team_ct.score',
      defaultDisplayText: 'CT {value}',
      fallback: 'CT 0',
      description: '显示CT队比分',
    },
  ],
  weapons: [
    {
      key: 'currentWeapon',
      label: '当前武器',
      dataField: 'player.weapons.active',
      defaultDisplayText: '当前武器: {value}',
      fallback: '当前武器: 无',
      description: '显示当前武器',
    },
    {
      key: 'secondaryWeapon',
      label: '副武器',
      dataField: 'player.weapons.secondary',
      defaultDisplayText: '副武器: {value}',
      fallback: '副武器: 无',
      description: '显示副武器',
    },
    {
      key: 'grenades',
      label: '道具',
      dataField: 'player.weapons.grenades',
      defaultDisplayText: '道具: {value}',
      fallback: '道具: 无',
      description: '显示道具',
    },
  ],
  agentstream: [
    {
      key: 'content',
      label: '内容',
      dataField: 'agent.content',
      defaultDisplayText: '{value}',
      fallback: '等待 Agent 回复...',
      description: '显示Agent流式内容',
    },
  ],
};

// 获取组件的文字字段定义
export function getWidgetTextFields(widgetName: string): TextFieldDefinition[] {
  return widgetTextFields[widgetName] || [];
}

// 从数据对象中获取字段值
export function getDataFieldValue(data: any, fieldPath: string): any {
  const parts = fieldPath.split('.');
  let value = data;
  for (const part of parts) {
    if (value == null) return null;
    value = value[part];
  }
  return value;
}

// 格式化显示文本
export function formatDisplayText(template: string, value: any, fallback: string = ''): string {
  if (value == null || value === '') {
    return fallback;
  }
  return template.replace(/{value}/g, String(value));
}

