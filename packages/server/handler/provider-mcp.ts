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
                const tools = listTools().map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
                }));
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'notifications/initialized') {
                // MCP协议：客户端初始化完成通知
                this.response.type = 'application/json';
                this.response.body = reply({ result: {} });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callTool(this.ctx, { name, arguments: args });
                
                // 记录并广播（纯内存，不存储到数据库）
                try {
                    const log = {
                        timestamp: Date.now(),
                        level: 'info',
                        message: `Tool called: ${name}`,
                        tool: name,
                        metadata: { args, result, duration: Date.now() - startTime },
                    };
                    // 使用全局context确保事件能传播到所有订阅者
                    const globalCtx = (global as any).__cordis_ctx || this.ctx;
                    try { await (globalCtx as any).emit('mcp/log', log); } catch (e) {
                        logger.debug('[provider-mcp] emit log failed', e);
                    }
                } catch {}
                
                // MCP协议要求返回格式：{ content: [{ type: 'text', text: ... }] }
                const mcpResult = {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result)
                    }]
                };
                this.response.type = 'application/json';
                this.response.body = reply({ result: mcpResult });
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

// 主动连接到配置的WebSocket URL（客户端模式）
function startMCPConnection(ctx: Context) {
    // 使用 edge 逻辑来决定上游地址：优先 edgeUpstream，然后 ENV EDGE_UPSTREAM，最后 ws.endpoint
    // 使用 /mcp/ws 端点
    const normalizeFromHost = (host: string) => {
        if (!host) return '';
        if (/^https?:\/\//i.test(host)) {
            const base = host.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
            return new URL(base.endsWith('/') ? 'mcp/ws' : '/mcp/ws', base).toString();
        }
        if (/^wss?:\/\//i.test(host)) {
            return new URL(host.endsWith('/') ? 'mcp/ws' : '/mcp/ws', host).toString();
        }
        return `wss://${host}/mcp/ws`;
    };
    const fromHost = normalizeFromHost((config as any).host || '');
    const target = (config as any).edgeUpstream
        || process.env.EDGE_UPSTREAM
        || fromHost
        || config.ws?.endpoint
        || '';
    
    if (!target) {
        logger.warn('[provider-mcp] 未配置WebSocket endpoint，跳过主动连接。请设置 edgeUpstream、EDGE_UPSTREAM 或 ws.endpoint');
        return () => {};
    }

    // 如果配置的是路径，需要转换为完整URL
    let wsUrl = target;
    if (!target.startsWith('ws://') && !target.startsWith('wss://')) {
        // 如果是路径，使用当前服务器地址
        const port = config.port || 5285;
        wsUrl = `ws://localhost:${port}${target.startsWith('/') ? target : '/' + target}`;
        logger.warn('[provider-mcp] endpoint配置为路径，已转换为: %s', wsUrl);
    }

    let WS: any;
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        WS = require('ws');
    } catch (e) {
        logger.error('[provider-mcp] 缺少 ws 依赖，请安装依赖 "ws" 后重试。');
        return () => {};
    }

    let ws: any = null;
    let stopped = false;
    let retryDelay = 3000;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let connecting = false;
    let connectTimeout: NodeJS.Timeout | null = null;

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
        const nextDelay = Math.min(retryDelay, 30000);
        logger.info('[provider-mcp] 将在 %ds 后重试连接...', Math.round(nextDelay / 1000));
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!stopped) connect();
        }, nextDelay);
        retryDelay = Math.min(nextDelay * 2, 30000);
    };

    const handleMessage = async (data: any) => {
        try {
            // 记录原始数据以便调试
            let rawData: string;
            if (Buffer.isBuffer(data)) {
                rawData = data.toString('utf8');
            } else if (typeof data === 'string') {
                rawData = data;
            } else {
                rawData = JSON.stringify(data);
            }
            
            // 尝试解析 JSON
            let request: any;
            try {
                request = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
            } catch (parseError) {
                logger.warn('[provider-mcp] 无法解析消息为 JSON，原始内容: %s', rawData.substring(0, 200));
                return; // 无法解析的消息直接忽略
            }
            
            const id = request?.id ?? null;
            const method = request?.method;

            // 记录完整消息内容（用于调试）
            logger.debug('[provider-mcp] 收到消息: %s (id: %s), 完整内容: %s', method || 'unknown', id, JSON.stringify(request).substring(0, 500));
            logger.info('[provider-mcp] 收到消息: %s (id: %s)', method || 'unknown', id);

            const reply = (data: any) => {
                const response = { jsonrpc: '2.0', id, ...data };
                try {
                    ws.send(JSON.stringify(response));
                } catch (e) {
                    logger.error('[provider-mcp] 发送响应失败', e);
                }
            };

            // 处理 initialize 响应（id === 1 且没有 method 字段，说明是响应）
            if (id === 1 && request.result && !request.method) {
                // 这是 initialize 的响应
                logger.info('[provider-mcp] 收到 initialize 响应');
                // 发送 initialized 通知
                const initializedNotification = {
                    jsonrpc: '2.0',
                    method: 'notifications/initialized',
                };
                try {
                    ws.send(JSON.stringify(initializedNotification));
                    logger.info('[provider-mcp] 已发送 initialized 通知');
                } catch (e) {
                    logger.error('[provider-mcp] 发送 initialized 通知失败', e);
                }
                
                // 发送 provider 注册消息（类似 Node 的 init 消息）
                // 这样上游服务器才能识别这是一个 provider 连接并注册工具
                try {
                    const tools = listTools();
                    const providerInit = {
                        type: 'provider/init',
                        providerId: `provider_${Date.now()}`,
                        tools: tools.map((t: any) => ({
                            name: t.name,
                            description: t.description,
                            inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
                        })),
                    };
                    ws.send(JSON.stringify(providerInit));
                    logger.info('[provider-mcp] 已发送 provider 注册消息，工具数量: %d', tools.length);
                } catch (e) {
                    logger.error('[provider-mcp] 发送 provider 注册消息失败', e);
                }
                return;
            }

            if (method === 'initialize') {
                reply({
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {}, resources: {} },
                        serverInfo: { name: 'mcp-provider-server', version: '1.0.0' },
                    },
                });
                return;
            }

            if (method === 'tools/list') {
                const tools = listTools().map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
                }));
                reply({ result: { tools } });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                try {
                    const result = await callTool(ctx, { name, arguments: args });
                    
                    // 记录并广播（纯内存，不存储到数据库）
                    try {
                        const log = {
                            timestamp: Date.now(),
                            level: 'info',
                            message: `Tool called: ${name}`,
                            tool: name,
                            metadata: { args, result, duration: Date.now() - startTime },
                        };
                        // 使用全局context确保事件能传播到所有订阅者
                        const globalCtx = (global as any).__cordis_ctx || ctx;
                        try { await (globalCtx as any).emit('mcp/log', log); } catch (e) {
                            logger.debug('[provider-mcp] emit log failed', e);
                        }
                    } catch {}
                    
                    // MCP协议要求返回格式：{ content: [{ type: 'text', text: ... }] }
                    const mcpResult = {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(result)
                        }]
                    };
                    reply({ result: mcpResult });
                } catch (e) {
                    logger.error('[provider-mcp] tool call error', e);
                    reply({ error: { code: -32603, message: (e as Error).message } });
                }
                return;
            }

            // 处理通知（notifications）- 通知没有 id，也不应该有响应
            if (method && method.startsWith('notifications/')) {
                logger.info('[provider-mcp] 收到通知: %s', method);
                // 通知不需要响应，直接返回
                return;
            }

            // 处理上游服务器的自定义状态消息（非 JSON-RPC 格式）
            // 这些消息有 type 字段，但不是标准的 JSON-RPC 请求
            if (request.type && !method && id === null) {
                const msgType = request.type;
                // 静默处理常见的状态更新消息
                if (msgType === 'status/update' || msgType === 'tools/synced' || msgType === 'status/connected' || msgType === 'status/disconnected') {
                    logger.debug('[provider-mcp] 收到上游状态消息: %s', msgType);
                    return; // 静默忽略，不记录警告
                }
                // 其他未知的 type 消息也静默处理，但记录 debug 日志
                logger.debug('[provider-mcp] 收到上游自定义消息: %s', msgType);
                return;
            }

            // 处理 ping/pong 心跳消息（某些 WebSocket 实现会发送）
            if (rawData === 'ping' || rawData === 'PING' || request === 'ping' || request === 'PING') {
                try {
                    ws.send('pong');
                } catch {}
                return;
            }
            if (rawData === 'pong' || rawData === 'PONG' || request === 'pong' || request === 'PONG') {
                return; // 收到 pong，无需处理
            }

            // 如果是通知但没有 method，或者 id 为 null 且没有 method，可能是无效消息
            if (id === null && !method) {
                // 如果消息是空对象或只有 jsonrpc 字段，可能是格式错误
                if (Object.keys(request).length === 0 || (Object.keys(request).length === 1 && request.jsonrpc)) {
                    logger.debug('[provider-mcp] 忽略空消息或仅包含 jsonrpc 的消息');
                    return;
                }
                // 其他情况记录警告（但不会频繁出现，因为上面的 type 检查已经处理了大部分情况）
                logger.debug('[provider-mcp] 收到非标准消息（无 method 且无 id），原始内容: %s', rawData.substring(0, 200));
                return;
            }

            // 只有请求（有 id）才返回错误响应
            if (id !== null && id !== undefined) {
                reply({ error: { code: -32601, message: 'Method not found' } });
            } else {
                // 通知或无效消息，不发送响应
                logger.warn('[provider-mcp] 收到未知通知或无效消息: %s', method || 'unknown');
            }
        } catch (e) {
            logger.error('[provider-mcp] 处理消息失败', e);
            try {
                ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32700, message: 'Parse error' },
                }));
            } catch {}
        }
    };

    const connect = () => {
        if (stopped) return;
        if (connecting) return;
        connecting = true;

        logger.info('[provider-mcp] 正在连接到: %s', wsUrl);

        if (connectTimeout) {
            clearTimeout(connectTimeout);
        }
        connectTimeout = setTimeout(() => {
            if (connecting && ws && ws.readyState !== (ws as any).OPEN) {
                logger.warn('[provider-mcp] 连接超时');
                ws.close();
                connecting = false;
                scheduleReconnect();
            }
        }, 10000);

        try {
            ws = new WS(wsUrl);

            ws.on('open', () => {
                if (connectTimeout) {
                    clearTimeout(connectTimeout);
                    connectTimeout = null;
                }
                logger.info('[provider-mcp] 已连接到: %s', wsUrl);
                retryDelay = 3000;
                connecting = false;
                
                // MCP协议：连接后立即发送初始化请求
                const initRequest = {
                    jsonrpc: '2.0',
                    method: 'initialize',
                    id: 1,
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {},
                        },
                        clientInfo: {
                            name: 'mcp-provider-server',
                            version: '1.0.0',
                        },
                    },
                };
                
                try {
                    ws.send(JSON.stringify(initRequest));
                    logger.info('[provider-mcp] 已发送 initialize 请求');
                } catch (e) {
                    logger.error('[provider-mcp] 发送 initialize 请求失败', e);
                }
            });

            ws.on('message', (data: any) => {
                handleMessage(data);
            });

            ws.on('close', (code: number, reason: Buffer) => {
                logger.info('[provider-mcp] 连接已关闭 (code: %s, reason: %s)', code, reason?.toString() || '');
                connecting = false;
                if (!stopped) {
                    scheduleReconnect();
                }
            });

            ws.on('error', (err: Error) => {
                logger.error('[provider-mcp] WebSocket错误: %s', err.message);
                connecting = false;
                if (!stopped) {
                    scheduleReconnect();
                }
            });
        } catch (e) {
            logger.error('[provider-mcp] 连接失败', e);
            connecting = false;
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            scheduleReconnect();
        }
    };

    // 延迟连接，等待服务就绪
    setTimeout(() => {
        connect();
    }, 1000);

    return () => {
        stopped = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        if (ws) {
            try {
                ws.close();
            } catch {}
            ws = null;
        }
    };
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
                const tools = listTools().map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
                }));
                this.response.type = 'application/json';
                this.response.body = reply({ result: { tools } });
                return;
            }

            if (method === 'notifications/initialized') {
                // MCP协议：客户端初始化完成通知
                this.response.type = 'application/json';
                this.response.body = reply({ result: {} });
                return;
            }

            if (method === 'tools/call') {
                const { name, arguments: args } = request.params || {};
                const startTime = Date.now();
                
                logger.info('[MCP工具调用] %s 参数: %o', name, args);
                
                const result = await callTool(this.ctx, { name, arguments: args });
                
                // 记录并广播（纯内存，不存储到数据库）
                try {
                    const log = {
                        timestamp: Date.now(),
                        level: 'info',
                        message: `Tool called: ${name}`,
                        tool: name,
                        metadata: { args, result, duration: Date.now() - startTime },
                    };
                    // 使用全局context确保事件能传播到所有订阅者
                    const globalCtx = (global as any).__cordis_ctx || this.ctx;
                    try { await (globalCtx as any).emit('mcp/log', log); } catch (e) {
                        logger.debug('[provider-mcp] emit log failed', e);
                    }
                } catch {}
                
                // MCP协议要求返回格式：{ content: [{ type: 'text', text: ... }] }
                const mcpResult = {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result)
                    }]
                };
                this.response.type = 'application/json';
                this.response.body = reply({ result: mcpResult });
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
                
                logger.debug('[provider-mcp/client] 收到消息: %o', message);
                
                // 处理 tools/list 请求
                if (message.method === 'tools/list') {
                    const tools = listTools();
                    try {
                        ws.send(JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: { tools },
                        }));
                        logger.info('[provider-mcp/client] 已发送工具列表: %d 个工具', tools.length);
                    } catch (e) {
                        logger.warn('发送工具列表失败: %s', (e as Error).message);
                    }
                    return;
                }

                // 处理 tools/call 请求
                if (message.method === 'tools/call') {
                    const params = message.params || {};
                    const name = params.name;
                    const args = params.arguments || params.args || {};
                    
                    logger.info('[provider-mcp/client] 工具调用请求: name=%s, args=%o', name, args);
                    
                    if (!name) {
                        logger.error('[provider-mcp/client] 工具调用缺少名称');
                        ws.send(JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            error: { code: -32602, message: 'Missing tool name' },
                        }));
                        return;
                    }
                    
                    const startTime = Date.now();
                    
                    try {
                        const result = await callTool(ctx, { name, arguments: args });
                        
                        logger.info('[provider-mcp/client] 工具调用成功: name=%s, duration=%dms', name, Date.now() - startTime);
                        
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
                        logger.error('[provider-mcp/client] 工具调用失败: name=%s, error=%s', name, (e as Error).message);
                        ws.send(JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            error: { code: -32603, message: (e as Error).message },
                        }));
                    }
                    return;
                }

                // 处理 initialize 响应
                if (message.id === 1 && message.result) {
                    logger.info('[provider-mcp/client] 初始化完成: %o', message.result);
                    return;
                }

                logger.debug('[provider-mcp/client] 未处理的消息类型: method=%s', message.method);
            } catch (e) {
                logger.warn('[provider-mcp/client] 处理 MCP 消息失败: %s', (e as Error).message);
                logger.debug('[provider-mcp/client] 错误堆栈: %s', (e as Error).stack);
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
    
    // 主动连接到配置的WebSocket URL（客户端模式）
    if (config.ws?.enabled !== false && config.ws?.endpoint) {
        const disconnect = startMCPConnection(ctx);
        // 在进程退出时断开连接
        const cleanup = () => {
            try {
                disconnect();
            } catch (err: any) {
                logger.error('[provider-mcp] 清理连接失败: %s', err.message);
            }
            // 确保进程能够退出
            setTimeout(() => {
                process.exit(0);
            }, 500);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('exit', () => {
            try {
                disconnect();
            } catch { /* ignore */ }
        });
    } else if (config.ws?.enabled !== false) {
        logger.warn('[provider-mcp] WebSocket已启用但未配置endpoint，请设置 ws.endpoint');
    }
}

