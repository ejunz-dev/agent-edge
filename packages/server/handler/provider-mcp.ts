import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { callTool, listTools } from '../mcp-tools/provider-index';
import { config } from '../config';
import { Logger } from '../utils';

const logger = new Logger('handler/provider-mcp');

// HTTP MCP API Handler
class ProviderMCPApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'MCP Provider Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    tools: listTools().map(t => t.name),
                },
                id: null,
            };
            this.response.type = 'application/json';
            this.response.body = payload;
        } catch (e) {
            this.response.type = 'application/json';
            this.response.body = { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null };
        }
    }

    async post(params) {
        const request = this.request.body;
        const id = request?.id ?? null;
        const method = request?.method;

        logger.info('[provider-mcp/api] incoming', {
            method: this.request.method,
            path: this.request.path,
            body: request,
        } as any);

        const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

        if (method === 'initialize') {
            this.response.type = 'application/json';
            this.response.body = reply({
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: 'mcp-provider-server', version: '1.0.0' },
                },
            });
            return;
        }

        try {
            if (method === 'tools/list') {
                const tools = listTools();
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callTool(this.ctx, { name, arguments: args });
                
                // 记录并广播
                try {
                    const log = await this.ctx.db.mcplog.insert({
                        timestamp: Date.now(),
                        level: 'info',
                        message: `Tool called: ${name}`,
                        tool: name,
                        metadata: { args, result, duration: Date.now() - startTime },
                    });
                    try { await (this.ctx as any).emit('mcp/log', log); } catch {}
                } catch {}
                
                this.response.type = 'application/json';
                this.response.body = reply({ result });
                return;
            }
        } catch (e) {
            logger.error('[provider-mcp/api] error', e);
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}

// WebSocket MCP Handler
export class ProviderMCPWebSocketHandler extends ConnectionHandler<Context> {
    async open() {
        logger.info('[provider-mcp/ws] connection opened');
    }

    async message(data: any) {
        try {
            const request = typeof data === 'string' ? JSON.parse(data) : data;
            const id = request?.id ?? null;
            const method = request?.method;

            logger.info('[provider-mcp/ws] incoming', { method, id });

            const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

            if (method === 'initialize') {
                this.send(reply({
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {}, resources: {} },
                        serverInfo: { name: 'mcp-provider-server', version: '1.0.0' },
                    },
                }));
                return;
            }

            if (method === 'tools/list') {
                const tools = listTools();
                this.send(reply({ result: { tools } }));
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                try {
                    const result = await callTool(this.ctx, { name, arguments: args });
                    
                    // 记录并广播
                    try {
                        const log = await this.ctx.db.mcplog.insert({
                            timestamp: Date.now(),
                            level: 'info',
                            message: `Tool called: ${name}`,
                            tool: name,
                            metadata: { args, result, duration: Date.now() - startTime },
                        });
                        try { await (this.ctx as any).emit('mcp/log', log); } catch {}
                    } catch {}
                    
                    this.send(reply({ result }));
                } catch (e) {
                    logger.error('[provider-mcp/ws] tool call error', e);
                    this.send(reply({ error: { code: -32603, message: (e as Error).message } }));
                }
                return;
            }

            this.send(reply({ error: { code: -32601, message: 'Method not found' } }));
        } catch (e) {
            logger.error('[provider-mcp/ws] error', e);
            this.send({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            });
        }
    }

    async close() {
        logger.info('[provider-mcp/ws] connection closed');
    }
}

// HTTP/SSE API Handler (for external access like http://mcp.ejunz.com/api)
class ProviderExternalApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'MCP Provider Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    tools: listTools().map(t => t.name),
                    endpoints: {
                        http: '/api',
                        websocket: config.ws?.enabled !== false ? (config.ws?.endpoint || '/mcp/ws') : null,
                    },
                },
                id: null,
            };
            this.response.type = 'application/json';
            this.response.body = payload;
        } catch (e) {
            this.response.type = 'application/json';
            this.response.body = { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null };
        }
    }

    async post(params) {
        const request = this.request.body;
        const id = request?.id ?? null;
        const method = request?.method;

        logger.info('[provider-external-api] incoming', {
            method: this.request.method,
            path: this.request.path,
            body: request,
        } as any);

        const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

        if (method === 'initialize') {
            this.response.type = 'application/json';
            this.response.body = reply({
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: 'mcp-provider-server', version: '1.0.0' },
                },
            });
            return;
        }

        try {
            if (method === 'tools/list') {
                const tools = listTools();
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callTool(this.ctx, { name, arguments: args });
                
                // 记录并广播
                try {
                    const log = await this.ctx.db.mcplog.insert({
                        timestamp: Date.now(),
                        level: 'info',
                        message: `Tool called: ${name}`,
                        tool: name,
                        metadata: { args, result, duration: Date.now() - startTime },
                    });
                    try { await (this.ctx as any).emit('mcp/log', log); } catch {}
                } catch {}
                
                this.response.type = 'application/json';
                this.response.body = reply({ result });
                return;
            }
        } catch (e) {
            logger.error('[provider-external-api] error', e);
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}

// SSE Logs Handler
class ProviderLogsSSEHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        // 设置SSE响应头
        this.response.type = 'text/event-stream';
        this.response.addHeader('Cache-Control', 'no-cache');
        this.response.addHeader('Connection', 'keep-alive');
        this.response.addHeader('X-Accel-Buffering', 'no');

        // 发送初始连接消息
        this.response.body = 'data: ' + JSON.stringify({ type: 'connected', timestamp: Date.now() }) + '\n\n';

        // 订阅日志事件
        const dispose = (this.ctx as any).on('mcp/log', (log: any) => {
            try {
                const data = 'data: ' + JSON.stringify(log) + '\n\n';
                // 注意：这里需要直接写入响应流，但框架可能不支持
                // 作为替代，我们可以使用WebSocket或者定期轮询
            } catch (e) {
                logger.error('Failed to send SSE log', e);
            }
        });

        // 保持连接（实际实现可能需要使用流式响应）
        // 这里先返回初始消息，实际日志通过WebSocket或轮询获取
        return;
    }
}

// 连接到上游 MCP endpoint（作为客户端）
function setupProviderMCPClient(ctx: Context) {
    const wsConfig = (config as any).ws || {};
    const upstream = wsConfig.upstream;
    const enabled = wsConfig.enabled !== false;

    if (!enabled || !upstream) {
        logger.info('Provider MCP 客户端未启用或未配置 upstream');
        return () => {};
    }

    // 检查 upstream 是否是完整的 WebSocket URL
    if (!upstream.startsWith('ws://') && !upstream.startsWith('wss://')) {
        logger.warn('Provider MCP upstream 必须是完整的 WebSocket URL (ws:// 或 wss://)');
        return () => {};
    }

    let WS: any;
    try {
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请安装: npm install ws');
        return () => {};
    }

    let ws: any = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let retryDelay = 5000;
    let stopped = false;

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, retryDelay);
        logger.info('将在 %d 秒后重试连接 MCP upstream', Math.round(retryDelay / 1000));
        retryDelay = Math.min(retryDelay * 1.5, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) return;

        logger.info('连接到 MCP upstream: %s', upstream);
        ws = new WS(upstream, { perMessageDeflate: false });

        ws.on('open', () => {
            logger.success('已连接到 MCP upstream: %s', upstream);
            retryDelay = 5000;
            
            // 发送初始化消息
            try {
                ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                }));
            } catch (e) {
                logger.warn('发送初始化消息失败: %s', (e as Error).message);
            }
        });

        ws.on('message', async (data: any) => {
            try {
                const text = typeof data === 'string' ? data : data.toString('utf8');
                const message = JSON.parse(text);
                
                // 处理 tools/list 请求
                if (message.method === 'tools/list' || (message.params && message.params.method === 'tools/list')) {
                    const tools = listTools();
                    try {
                        ws.send(JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: { tools },
                        }));
                    } catch (e) {
                        logger.warn('发送工具列表失败: %s', (e as Error).message);
                    }
                    return;
                }

                // 处理 tools/call 请求
                if (message.method === 'tools/call' || (message.params && message.params.method === 'tools/call')) {
                    const { name, arguments: args } = message.params || {};
                    const startTime = Date.now();
                    
                    try {
                        const result = await callTool(ctx, { name, arguments: args });
                        
                        // 记录日志
                        try {
                            const log = await ctx.db.mcplog.insert({
                                timestamp: Date.now(),
                                level: 'info',
                                message: `Tool called: ${name}`,
                                tool: name,
                                metadata: { args, result, duration: Date.now() - startTime },
                            });
                            try { await (ctx as any).emit('mcp/log', log); } catch {}
                        } catch {}
                        
                        ws.send(JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            result,
                        }));
                    } catch (e) {
                        logger.error('工具调用失败: %s', (e as Error).message);
                        ws.send(JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            error: { code: -32603, message: (e as Error).message },
                        }));
                    }
                    return;
                }

                logger.debug('收到 MCP 消息: %o', message);
            } catch (e) {
                logger.warn('处理 MCP 消息失败: %s', (e as Error).message);
            }
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('MCP upstream 连接已关闭 (%s): %s', code, reason?.toString?.() || '');
            ws = null;
            if (!stopped) scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.error('MCP upstream 连接错误: %s', err.message);
        });
    };

    connect();

    return () => {
        stopped = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            try { ws.close(); } catch {}
            ws = null;
        }
    };
}

export async function apply(ctx: Context) {
    // HTTP MCP API (internal)
    ctx.Route('provider_mcp_api', '/mcp/api', ProviderMCPApiHandler);
    
    // HTTP/SSE API (external, like http://mcp.ejunz.com/api)
    ctx.Route('provider_external_api', '/api', ProviderExternalApiHandler);
    
    // SSE Logs (for real-time log monitoring)
    ctx.Route('provider_logs_sse', '/api/logs/sse', ProviderLogsSSEHandler);
    
    // WebSocket MCP Handler（作为服务器端，如果启用）
    if (config.ws?.enabled !== false) {
        const endpoint = config.ws?.endpoint || '/mcp/ws';
        ctx.Connection('provider_mcp_ws', endpoint, ProviderMCPWebSocketHandler);
        logger.info(`MCP WebSocket endpoint (server): ${endpoint}`);
    }
    
    // 连接到上游 MCP endpoint（作为客户端）
    const dispose = setupProviderMCPClient(ctx);
    if (dispose) {
        // 在服务停止时清理连接
        ctx.on('dispose' as any, dispose);
    }
}

