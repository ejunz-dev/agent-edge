// @ts-nocheck
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { 
    zigbeeListDevicesTool, 
    callZigbeeListDevicesTool,
    zigbeeGetDeviceStatusTool,
    callZigbeeGetDeviceStatusTool,
    zigbeeControlTool, 
    callZigbeeControlTool 
} from './nodeZigbee';

const logger = new Logger('node-mcp');

// Node 端的工具注册表
export const nodeToolRegistry: Record<string, {
    tool: any;
    handler: (ctx: Context, args: any) => Promise<any>;
}> = {
    'zigbee_list_devices': {
        tool: zigbeeListDevicesTool,
        handler: callZigbeeListDevicesTool,
    },
    'zigbee_get_device_status': {
        tool: zigbeeGetDeviceStatusTool,
        handler: callZigbeeGetDeviceStatusTool,
    },
    'zigbee_control_device': {
        tool: zigbeeControlTool,
        handler: callZigbeeControlTool,
    },
};

// 获取所有 Node 工具列表
export function listNodeTools() {
    return Object.values(nodeToolRegistry).map((entry) => entry.tool);
}

// 调用 Node 工具
export async function callNodeTool(ctx: Context, request: { name: string; arguments: any }): Promise<any> {
    const { name, arguments: args } = request;
    const startTime = Date.now();
    
    // 记录工具调用开始
    logger.info('[MCP工具调用] %s 参数: %o', name, args);
    
    const entry = nodeToolRegistry[name];
    if (!entry) {
        logger.error('[MCP工具调用] 未知工具: %s', name);
        throw new Error(`Unknown node tool: ${name}`);
    }
    
    try {
        const result = await entry.handler(ctx, args);
        const duration = Date.now() - startTime;
        
        // 记录工具调用成功
        const resultPreview = typeof result === 'object' 
            ? JSON.stringify(result).substring(0, 200) 
            : String(result).substring(0, 200);
        logger.success('[MCP工具调用] %s 成功 (耗时: %dms) 结果: %s', name, duration, resultPreview);
        
        return result;
    } catch (error) {
        const duration = Date.now() - startTime;
        logger.error('[MCP工具调用] %s 失败 (耗时: %dms) 错误: %s', name, duration, (error as Error).message);
        throw error;
    }
}

