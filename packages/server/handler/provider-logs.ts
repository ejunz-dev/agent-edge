import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Logger } from '../utils';

const logger = new Logger('handler/provider-logs');

// WebSocket Logs Handler (for real-time log monitoring)
export class ProviderLogsConnectionHandler extends ConnectionHandler<Context> {
    static active = new Set<ProviderLogsConnectionHandler>();
    private subscriptions: Array<{ dispose: () => void }> = [];

    async open() {
        ProviderLogsConnectionHandler.active.add(this);
        logger.info('[provider-logs/ws] connection opened');
        
        // 发送初始连接消息
        this.send({ type: 'connected', timestamp: Date.now() });
        
        // 订阅日志事件
        const dispose = this.ctx.on('mcp/log', (log: any) => {
            try {
                this.send({ type: 'log', data: log });
            } catch (e) {
                logger.error('Failed to send log via WebSocket', e);
            }
        });
        
        this.subscriptions.push({ dispose });
        
        // 发送最近的日志（可选）
        try {
            const recentLogs = await this.ctx.db.mcplog.find({})
                .sort({ timestamp: -1 })
                .limit(50)
                .exec();
            
            for (const log of recentLogs.reverse()) {
                this.send({ type: 'log', data: log });
            }
        } catch (e) {
            logger.debug('Failed to load recent logs', e);
        }
    }

    async close() {
        ProviderLogsConnectionHandler.active.delete(this);
        for (const sub of this.subscriptions) {
            sub.dispose();
        }
        logger.info('[provider-logs/ws] connection closed');
    }
}

// HTTP Logs API Handler
class ProviderLogsApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const limit = parseInt(this.request.query.limit as string) || 100;
            const tool = this.request.query.tool as string;
            const level = this.request.query.level as string;
            
            const query: any = {};
            if (tool) query.tool = tool;
            if (level) query.level = level;
            
            const logs = await this.ctx.db.mcplog.find(query)
                .sort({ timestamp: -1 })
                .limit(limit)
                .exec();
            
            this.response.type = 'application/json';
            this.response.body = {
                logs: logs.reverse(), // 按时间正序返回
                total: logs.length,
            };
        } catch (e) {
            logger.error('Failed to get logs', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export async function apply(ctx: Context) {
    // WebSocket Logs Handler
    ctx.Connection('provider_logs_ws', '/api/logs/ws', ProviderLogsConnectionHandler);
    
    // HTTP Logs API
    ctx.Route('provider_logs_api', '/api/logs', ProviderLogsApiHandler);
}

