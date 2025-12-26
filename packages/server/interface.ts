declare module 'cordis' {
    interface Context {
        params: any;
        fetcher: any;
        voice: import('./service/voice').IVoiceService;
    }
    interface Events {
        'app/started': () => void
        'app/ready': () => VoidReturn
        'app/exit': () => VoidReturn
    }
}

export type VoidReturn = Promise<any> | any;

export interface MCPLogDoc {
    _id: string;
    timestamp: number;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    tool?: string;
    metadata?: Record<string, any>;
}

export interface MCPToolDoc {
    _id: string;
    name: string;
    description: string;
    server: string;
    callCount: number;
    lastCalled?: number;
    createdAt: number;
    metadata?: Record<string, any>;
}

export interface MCPServerDoc {
    _id: string;
    name: string;
    endpoint: string;
    status: 'online' | 'offline';
    toolCount: number;
    totalCalls: number;
    lastUpdate: number;
    createdAt: number;
    metadata?: Record<string, any>;
}

export interface VTuberAuthTokenDoc {
    _id: string;
    host: string;
    port: number;
    authToken: string;
    updatedAt: number;
    createdAt: number;
}

export interface WidgetConfigDoc {
    _id: string;
    widgetName: string;
    config: Record<string, any>;
    updatedAt: number;
    createdAt: number;
}

export interface EventConfigDoc {
    _id: string;
    sceneId: string; // 事件所属的场景 ID
    name: string;
    enabled: boolean;
    trigger: {
        field: string; // GSI 字段路径，如 "round.phase"
        operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains';
        value: any;
    };
    actions: Array<{
        widgetName: string; // 组件名称
        effect: 'show' | 'hide' | 'toggle'; // 效果
        duration?: number; // 持续时间（秒），0 表示永久
    }>;
    updatedAt: number;
    createdAt: number;
}

export interface SceneConfigDoc {
    _id: string;
    name: string;
    active: boolean; // 是否激活（只有一个场景可以是激活状态）
    widgetDefaults?: Record<string, boolean>; // 组件默认状态配置，key为组件名称，value为默认可见性
    updatedAt: number;
    createdAt: number;
}