import { Context } from 'cordis';
import {
    callServerStatusTool, serverStatusTool,
} from './serverStatus';
import {
    callGetCurrentTimeTool, getCurrentTimeTool,
} from './timeTools';

export interface MCPToolRegistry {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
    };
}

export interface MCPToolCallRequest {
    name: string;
    arguments: Record<string, any>;
}

// 工具注册表
export const toolRegistry: Record<string, {
    tool: MCPToolRegistry;
    handler: (ctx: Context, args: any) => Promise<any>;
}> = {
    'get_server_status': {
        tool: serverStatusTool,
        handler: callServerStatusTool,
    },
    'get_current_time': {
        tool: getCurrentTimeTool,
        handler: callGetCurrentTimeTool,
    },
};

// 获取所有注册的工具列表
export function listTools(): MCPToolRegistry[] {
    return Object.values(toolRegistry).map((entry) => entry.tool);
}

// 调用工具
export async function callTool(ctx: Context, request: MCPToolCallRequest): Promise<any> {
    const { name, arguments: args } = request;
    
    const entry = toolRegistry[name];
    if (!entry) {
        throw new Error(`Unknown tool: ${name}`);
    }
    
    return await entry.handler(ctx, args);
}

// 检查工具是否存在
export function hasTool(name: string): boolean {
    return name in toolRegistry;
}

// 获取工具信息
export function getTool(name: string): MCPToolRegistry | undefined {
    return toolRegistry[name]?.tool;
}

