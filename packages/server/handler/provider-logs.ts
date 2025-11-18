import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Logger } from '../utils';

const logger = new Logger('handler/provider-logs');

// 内存日志缓冲区（最多保留最近1000条日志）
const memoryLogBuffer: Array<{
    timestamp: number;
    level: string;
    message: string;
    tool?: string;
    metadata?: Record<string, any>;
}> = [];
const MAX_BUFFER_SIZE = 1000;

// 添加日志到内存缓冲区
function addLogToBuffer(log: any) {
    memoryLogBuffer.push({
        timestamp: log.timestamp || Date.now(),
        level: log.level || 'info',
        message: log.message || '',
        tool: log.tool,
        metadata: log.metadata,
    });
    // 保持缓冲区大小
    if (memoryLogBuffer.length > MAX_BUFFER_SIZE) {
        memoryLogBuffer.shift();
    }
}

// WebSocket Logs Handler (for real-time log monitoring)
export class ProviderLogsConnectionHandler extends ConnectionHandler<Context> {
    static active = new Set<ProviderLogsConnectionHandler>();
    private subscriptions: Array<{ dispose: () => void }> = [];
    noCheckPermView = true; // 允许WebSocket连接，不需要权限检查

    async prepare() {
        ProviderLogsConnectionHandler.active.add(this);
        logger.info('[provider-logs/ws] connection opened');
        
        // 发送初始连接消息
        this.send({ type: 'connected', timestamp: Date.now() });
        
        // 订阅日志事件（使用全局context确保能接收到所有事件）
        const globalCtx = (global as any).__cordis_ctx || this.ctx;
        const dispose = (globalCtx as any).on('mcp/log', (log: any) => {
            try {
                this.send({ type: 'log', data: log });
            } catch (e) {
                logger.error('Failed to send log via WebSocket', e);
            }
        });
        
        this.subscriptions.push({ dispose });
        
        // 发送内存缓冲区中的最近日志（最多50条）
        try {
            const recentLogs = memoryLogBuffer.slice(-50);
            for (const log of recentLogs) {
                this.send({ type: 'log', data: log });
            }
        } catch (e) {
            logger.debug('Failed to send recent logs', e);
        }
    }

    async cleanup() {
        ProviderLogsConnectionHandler.active.delete(this);
        for (const sub of this.subscriptions) {
            sub.dispose();
        }
        logger.info('[provider-logs/ws] connection closed');
    }
}

// HTTP Logs API Handler (从内存缓冲区读取)
class ProviderLogsApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const limit = parseInt(this.request.query.limit as string) || 100;
            const tool = this.request.query.tool as string;
            const level = this.request.query.level as string;
            
            // 从内存缓冲区过滤日志
            let filteredLogs = [...memoryLogBuffer];
            
            if (tool) {
                filteredLogs = filteredLogs.filter(log => log.tool === tool);
            }
            if (level) {
                filteredLogs = filteredLogs.filter(log => log.level === level);
            }
            
            // 限制数量
            filteredLogs = filteredLogs.slice(-limit);
            
            this.response.type = 'application/json';
            this.response.body = {
                logs: filteredLogs,
                total: filteredLogs.length,
            };
        } catch (e) {
            logger.error('Failed to get logs', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export async function apply(ctx: Context) {
    // 订阅日志事件，添加到内存缓冲区（使用全局context确保能接收到所有事件）
    const globalCtx = (global as any).__cordis_ctx || ctx;
    globalCtx.on('mcp/log', (log: any) => {
        addLogToBuffer(log);
    });
    
    // WebSocket Logs Handler
    ctx.Connection('provider_logs_ws', '/api/logs/ws', ProviderLogsConnectionHandler);
    
    // HTTP Logs API
    ctx.Route('provider_logs_api', '/api/logs', ProviderLogsApiHandler);
}

