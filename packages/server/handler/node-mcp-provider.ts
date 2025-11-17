import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { listNodeTools } from '../mcp-tools/node';
import { callNodeTool } from '../mcp-tools/node';
import { config } from '../config';
import { Logger } from '../utils';

const logger = new Logger('handler/node-mcp-provider');

// HTTP MCP API Handler
class NodeMCPApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const tools = listNodeTools(true);
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'Node MCP Provider Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    tools: tools.map((t: any) => t.name),
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

        logger.info('[node-mcp/api] incoming', {
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
                    serverInfo: { name: 'node-mcp-provider-server', version: '1.0.0' },
                },
            });
            return;
        }

        try {
            if (method === 'tools/list') {
                const tools = listNodeTools(true);
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callNodeTool(this.ctx, { name, arguments: args });
                
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
            logger.error('[node-mcp/api] error', e);
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}

// WebSocket MCP Handler (作为服务器端)
export class NodeMCPWebSocketHandler extends ConnectionHandler<Context> {
    async open() {
        logger.info('[node-mcp/ws] connection opened');
    }

    async message(data: any) {
        try {
            const request = typeof data === 'string' ? JSON.parse(data) : data;
            const id = request?.id ?? null;
            const method = request?.method;

            logger.info('[node-mcp/ws] incoming', { method, id });

            const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

            if (method === 'initialize') {
                this.send(reply({
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {}, resources: {} },
                        serverInfo: { name: 'node-mcp-provider-server', version: '1.0.0' },
                    },
                }));
                return;
            }

            if (method === 'tools/list') {
                const tools = listNodeTools(true);
                this.send(reply({ result: { tools } }));
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                try {
                    const result = await callNodeTool(this.ctx, { name, arguments: args });
                    
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
                    logger.error('[node-mcp/ws] tool call error', e);
                    this.send(reply({ error: { code: -32603, message: (e as Error).message } }));
                }
                return;
            }

            this.send(reply({ error: { code: -32601, message: 'Method not found' } }));
        } catch (e) {
            logger.error('[node-mcp/ws] error', e);
            this.send({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            });
        }
    }

    async close() {
        logger.info('[node-mcp/ws] connection closed');
    }
}

// HTTP/SSE API Handler (for external access)
class NodeMCPExternalApiHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const tools = listNodeTools(true);
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'Node MCP Provider Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    tools: tools.map((t: any) => t.name),
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

        logger.info('[node-mcp-external-api] incoming', {
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
                    serverInfo: { name: 'node-mcp-provider-server', version: '1.0.0' },
                },
            });
            return;
        }

        try {
            if (method === 'tools/list') {
                const tools = listNodeTools(true);
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callNodeTool(this.ctx, { name, arguments: args });
                
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
            logger.error('[node-mcp-external-api] error', e);
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}

// 连接到上游 MCP endpoint（作为客户端）
function setupNodeMCPClient(ctx: Context) {
    const wsConfig = (config as any).ws || {};
    const endpoint = wsConfig.endpoint;
    const enabled = wsConfig.enabled !== false;

    if (!enabled || !endpoint) {
        logger.info('Node MCP 客户端未启用或未配置 endpoint');
        return () => {};
    }

    // 检查 endpoint 是否是完整的 WebSocket URL
    if (!endpoint.startsWith('ws://') && !endpoint.startsWith('wss://')) {
        logger.warn('Node MCP endpoint 必须是完整的 WebSocket URL (ws:// 或 wss://)');
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
        logger.info('将在 %d 秒后重试连接 MCP endpoint', Math.round(retryDelay / 1000));
        retryDelay = Math.min(retryDelay * 1.5, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) return;

        logger.info('连接到 MCP endpoint: %s', endpoint);
        ws = new WS(endpoint, { perMessageDeflate: false });

        ws.on('open', () => {
            logger.success('已连接到 MCP endpoint: %s', endpoint);
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
                    const tools = listNodeTools(true);
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
                        const result = await callNodeTool(ctx, { name, arguments: args });
                        
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
            logger.warn('MCP endpoint 连接已关闭 (%s): %s', code, reason?.toString?.() || '');
            ws = null;
            if (!stopped) scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.error('MCP endpoint 连接错误: %s', err.message);
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
    ctx.Route('node_mcp_api', '/mcp/api', NodeMCPApiHandler);
    
    // HTTP/SSE API (external)
    ctx.Route('node_mcp_external_api', '/api', NodeMCPExternalApiHandler);
    
    // WebSocket MCP Handler（作为服务器端，如果启用）
    const wsConfig = (config as any).ws || {};
    if (wsConfig.enabled !== false) {
        const localEndpoint = wsConfig.localEndpoint || '/mcp/ws';
        ctx.Connection('node_mcp_ws', localEndpoint, NodeMCPWebSocketHandler);
        logger.info(`Node MCP WebSocket endpoint (server): ${localEndpoint}`);
    }
    
    // 注意：上游 MCP 连接已由 client/node.ts 中的 Edge WS 统一协议处理
    // 不再使用旧的 setupNodeMCPClient，避免重复连接冲突
    // const dispose = setupNodeMCPClient(ctx);
    // if (dispose) {
    //     ctx.on('dispose' as any, dispose);
    // }
}

