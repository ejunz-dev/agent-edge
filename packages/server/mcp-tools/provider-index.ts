import { Context } from 'cordis';
import { config } from '../config';
import {
    callServerStatusTool, serverStatusTool,
} from './provider-server-status';
import {
    callGetCurrentTimeTool, getCurrentTimeTool,
} from './provider-time';

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

// 工具注册表（根据配置动态启用/禁用）
export function getToolRegistry(): Record<string, {
    tool: MCPToolRegistry;
    handler: (ctx: Context, args: any) => Promise<any>;
}> {
    const registry: Record<string, {
        tool: MCPToolRegistry;
        handler: (ctx: Context, args: any) => Promise<any>;
    }> = {};

    // 根据配置启用工具
    if (config.tools?.get_current_time?.enabled !== false) {
        registry['get_current_time'] = {
            tool: getCurrentTimeTool,
            handler: callGetCurrentTimeTool,
        };
    }

    if (config.tools?.get_server_status?.enabled !== false) {
        registry['get_server_status'] = {
            tool: serverStatusTool,
            handler: callServerStatusTool,
        };
    }

    return registry;
}

// 获取所有注册的工具列表
export function listTools(): MCPToolRegistry[] {
    const registry = getToolRegistry();
    return Object.values(registry).map((entry) => entry.tool);
}

// 调用工具
export async function callTool(ctx: Context, request: MCPToolCallRequest): Promise<any> {
    const { name, arguments: args } = request;
    
    const registry = getToolRegistry();
    const entry = registry[name];
    if (!entry) {
        throw new Error(`Unknown tool: ${name}`);
    }
    
    return await entry.handler(ctx, args);
}

// 检查工具是否存在
export function hasTool(name: string): boolean {
    const registry = getToolRegistry();
    return name in registry;
}

// 获取工具信息
export function getTool(name: string): MCPToolRegistry | undefined {
    const registry = getToolRegistry();
    return registry[name]?.tool;
}

