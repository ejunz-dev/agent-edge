import os from 'os';
import { Context } from 'cordis';

export interface MCPTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
    };
}

export interface MCPToolCall {
    name: string;
    arguments: Record<string, any>;
}

export const serverStatusTool: MCPTool = {
    name: 'get_server_status',
    description: '获取服务器状态信息，包括 CPU、内存、系统信息等',
    parameters: {
        type: 'object',
        properties: {
            includeDetails: {
                type: 'boolean',
                description: '是否包含详细信息',
                default: false,
            },
        },
        required: [],
    },
};

export async function callServerStatusTool(
    ctx: Context,
    args: { includeDetails?: boolean }
): Promise<any> {
    const { includeDetails = false } = args;
    
    // 记录工具调用
    await logToolCall(ctx, 'get_server_status', args);
    
    // 获取系统信息
    const platform = os.platform();
    const arch = os.arch();
    const hostname = os.hostname();
    const uptime = os.uptime();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const cpus = os.cpus();
    
    const result: any = {
        platform,
        arch,
        hostname,
        uptime_seconds: uptime,
        uptime_formatted: formatUptime(uptime),
        memory: {
            total: totalMemory,
            free: freeMemory,
            used: usedMemory,
            usage_percent: ((usedMemory / totalMemory) * 100).toFixed(2),
        },
        cpu_count: cpus.length,
    };
    
    if (includeDetails) {
        const loadAvg = os.loadavg();
        const networkInterfaces = os.networkInterfaces();
        
        result.cpu = {
            model: cpus[0]?.model || 'Unknown',
            speed: cpus[0]?.speed || 0,
            cores: cpus.length,
            load_average: loadAvg,
        };
        
        result.network = Object.entries(networkInterfaces).map(([name, interfaces]) => ({
            name,
            addresses: interfaces?.map((iface) => ({
                address: iface.address,
                family: iface.family,
                internal: iface.internal,
            })) || [],
        }));
        
        result.nodejs = {
            version: process.version,
            pid: process.pid,
            uptime: process.uptime(),
        };
    }
    
    return result;
}

function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
}

async function logToolCall(ctx: Context, toolName: string, args: any) {
    try {
        await ctx.db.mcplog.insert({
            timestamp: Date.now(),
            level: 'info',
            message: `Tool called: ${toolName}`,
            tool: toolName,
            metadata: args,
        });
    } catch (e) {
        // 如果数据库未初始化，忽略错误
        ctx.logger('mcp').debug('Failed to log tool call:', e);
    }
}

