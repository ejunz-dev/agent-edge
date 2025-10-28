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

export const getCurrentTimeTool: MCPTool = {
    name: 'get_current_time',
    description: '获取当前时间和日期信息',
    parameters: {
        type: 'object',
        properties: {
            timezone: {
                type: 'string',
                description: '时区（如: Asia/Shanghai），留空则使用本地时区',
            },
            format: {
                type: 'string',
                description: '时间格式（iso|unix|human），默认为 iso',
                default: 'iso',
            },
        },
        required: [],
    },
};

export async function callGetCurrentTimeTool(
    ctx: Context,
    args: { timezone?: string; format?: string }
): Promise<any> {
    const { timezone, format = 'iso' } = args;
    
    // 记录工具调用
    await logToolCall(ctx, 'get_current_time', args);
    
    const now = new Date();
    
    let formattedTime: string;
    let unixTimestamp: number;
    let isoString: string;
    
    switch (format) {
        case 'unix':
            unixTimestamp = Math.floor(now.getTime() / 1000);
            formattedTime = unixTimestamp.toString();
            isoString = now.toISOString();
            break;
        case 'human':
            formattedTime = now.toLocaleString('zh-CN', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });
            isoString = now.toISOString();
            unixTimestamp = Math.floor(now.getTime() / 1000);
            break;
        case 'iso':
        default:
            isoString = now.toISOString();
            formattedTime = isoString;
            unixTimestamp = Math.floor(now.getTime() / 1000);
            break;
    }
    
    const result: any = {
        timestamp: now.getTime(),
        unix_timestamp: unixTimestamp,
        iso_string: isoString,
        formatted: formattedTime,
        timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: now.getHours(),
        minute: now.getMinutes(),
        second: now.getSeconds(),
        weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    };
    
    if (timezone) {
        try {
            const tzTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
            result.timezone_time = {
                hour: tzTime.getHours(),
                minute: tzTime.getMinutes(),
                second: tzTime.getSeconds(),
            };
        } catch (e) {
            result.timezone_warning = `Invalid timezone: ${timezone}`;
        }
    }
    
    return result;
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
        ctx.logger('mcp').debug('Failed to log tool call:', e);
    }
}

