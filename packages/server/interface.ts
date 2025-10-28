declare module 'cordis' {
    interface Context {
        params: any;
        fetcher: any;
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
