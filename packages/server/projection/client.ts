// @ts-nocheck
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';

const logger = new Logger('projection-client');

// 全局 WebSocket 连接（用于向 server 发送消息）
let globalWsConnection: any = null;

/**
 * 获取全局 WebSocket 连接
 */
export function getGlobalWsConnection(): any {
    return globalWsConnection;
}

/**
 * 设置全局 WebSocket 连接
 */
export function setGlobalWsConnection(ws: any): void {
    globalWsConnection = ws;
}

// 已订阅的事件集合
const subscribedEvents = new Set<string>();

/**
 * 构建 WebSocket 连接 URL
 * 支持新协议格式：ws://your-domain/d/{domainId}/client/ws?token={wsToken}
 * 也支持旧格式：ws://your-domain/edge/conn（向后兼容）
 */
function buildWebSocketUrl(): string | null {
    const clientConfig = config as any;
    const server = clientConfig.server || '';
    const domainId = clientConfig.domainId || '';
    const wsToken = clientConfig.wsToken || '';
    
    // 如果配置了 domainId 和 wsToken，使用新协议格式
    if (domainId && wsToken) {
        let baseUrl = server;
        
        // 如果 server 是 HTTP/HTTPS URL，转换为 WebSocket URL
        if (/^https?:\/\//i.test(server)) {
            baseUrl = server.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        } else if (!/^wss?:\/\//i.test(server)) {
            // 如果不是完整 URL，添加协议
            baseUrl = `wss://${server}`;
        }
        
        try {
            const url = new URL(baseUrl);
            // 构建新协议路径：/d/{domainId}/client/ws?token={wsToken}
            url.pathname = `/d/${domainId}/client/ws`;
            url.search = `?token=${encodeURIComponent(wsToken)}`;
            return url.toString();
        } catch (e) {
            logger.error('构建 WebSocket URL 失败: %s', (e as Error).message);
            return null;
        }
    }
    
    // 向后兼容：使用旧格式
    if (server) {
        // 如果已经是完整的 WebSocket URL（包含路径），直接返回
        if (/^wss?:\/\//i.test(server)) {
            try {
                const url = new URL(server);
                // 如果 URL 已经包含路径（不只是根路径），直接返回
                if (url.pathname && url.pathname !== '/') {
                    return server;
                }
                // 如果只有根路径，添加 /edge/conn
                return new URL('/edge/conn', server).toString();
            } catch {
                // URL 解析失败，尝试直接使用
                return server;
            }
        }
        
        // 支持用户把 host 写成完整 HTTP/HTTPS URL
        if (/^https?:\/\//i.test(server)) {
            const base = server.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
            try {
                const url = new URL(base);
                // 如果 URL 已经包含路径（不只是根路径），直接返回转换后的 WebSocket URL
                if (url.pathname && url.pathname !== '/') {
                    return base;
                }
                // 如果只有根路径，添加 /edge/conn
                return new URL('/edge/conn', base).toString();
            } catch {
                // URL 解析失败，尝试添加 /edge/conn
                return new URL(base.endsWith('/') ? 'edge/conn' : '/edge/conn', base).toString();
            }
        }
        
        // 默认使用 wss，添加 /edge/conn
        return `wss://${server}/edge/conn`;
    }
    
    // 支持环境变量
    const envUpstream = process.env.EDGE_UPSTREAM || '';
    if (envUpstream) {
        return envUpstream;
    }
    
    return null;
}

/**
 * 发送 Cordis 事件系统消息
 */
function sendEvent(ws: any, key: 'publish' | 'subscribe' | 'unsubscribe' | 'ping', event: string, payload: any[] = []) {
    if (!ws || ws.readyState !== 1) { // WebSocket.OPEN = 1
        logger.warn('WebSocket 未连接，无法发送事件: %s', event);
        return;
    }
    
    const message = {
        key,
        event,
        payload,
    };
    
    try {
        ws.send(JSON.stringify(message));
        logger.debug?.('发送事件: %s %s', key, event);
    } catch (e) {
        logger.error('发送事件失败: %s', (e as Error).message);
    }
}

/**
 * 处理事件格式消息（新协议）
 */
function handleEventMessage(ws: any, msg: any) {
    const { event, payload } = msg;
    
    switch (event) {
        case 'tts/audio': {
            // TTS 音频事件，转发给前端处理
            // 上游服务器格式：payload = [{ audio: string }] - audio 是 base64 编码的音频数据
            const [audioData] = payload || [];
            if (audioData && audioData.audio) {
                logger.debug('[projection] 收到 TTS 音频事件');
                // 通过 Cordis 事件系统传播到前端
                try {
                    const ctx = (global as any).__cordis_ctx;
                    if (ctx) {
                        // 统一格式：传递 { audio: string } 或 { chunk: string } 以兼容前端
                        ctx.emit('projection/tts/audio', { audio: audioData.audio, chunk: audioData.audio });
                    }
                } catch (e) {
                    logger.debug('传播 TTS 音频事件失败: %s', (e as Error).message);
                }
            }
            break;
        }
        
        case 'agent/content': {
            // Agent 内容事件，转发给前端显示
            const [contentData] = payload || [];
            if (contentData) {
                logger.debug('[projection] 收到 Agent 内容事件: %s', typeof contentData === 'string' ? contentData.substring(0, 50) : 'object');
                try {
                    const ctx = (global as any).__cordis_ctx;
                    if (ctx) {
                        // 支持字符串和对象格式
                        const data = typeof contentData === 'string' ? { content: contentData } : contentData;
                        ctx.emit('projection/agent/content', data);
                    }
                } catch (e) {
                    logger.debug('传播 Agent 内容事件失败: %s', (e as Error).message);
                }
            }
            break;
        }
        
        case 'agent/content/start': {
            // Agent 内容开始事件
            logger.debug('[projection] Agent 内容开始');
            try {
                const ctx = (global as any).__cordis_ctx;
                if (ctx) {
                    ctx.emit('projection/agent/content/start', {});
                }
            } catch (e) {
                logger.debug('传播 Agent 内容开始事件失败: %s', (e as Error).message);
            }
            break;
        }
        
        case 'agent/content/end': {
            // Agent 内容结束事件
            const [contentData] = payload || [];
            logger.debug('[projection] Agent 内容结束');
            try {
                const ctx = (global as any).__cordis_ctx;
                if (ctx) {
                    ctx.emit('projection/agent/content/end', contentData || {});
                }
            } catch (e) {
                logger.debug('传播 Agent 内容结束事件失败: %s', (e as Error).message);
            }
            break;
        }
        
        case 'agent/message': {
            // Agent 消息事件（新协议）
            const [messageData] = payload || [];
            if (messageData) {
                logger.debug('[projection] 收到 Agent 消息事件');
                try {
                    const ctx = (global as any).__cordis_ctx;
                    if (ctx) {
                        ctx.emit('projection/agent/message', messageData);
                    }
                } catch (e) {
                    logger.debug('传播 Agent 消息事件失败: %s', (e as Error).message);
                }
            }
            break;
        }
        
        case 'tts/started': {
            // TTS 开始事件（上游服务器发送）
            logger.info('[projection] ✅ 收到 TTS 开始事件 (tts/started)');
            try {
                const ctx = (global as any).__cordis_ctx;
                if (ctx) {
                    ctx.emit('projection/tts/start', {});
                    logger.info('[projection] ✅ 已转发 TTS 开始事件到前端');
                }
            } catch (e) {
                logger.error('传播 TTS 开始事件失败: %s', (e as Error).message);
            }
            break;
        }
        
        case 'tts/done': {
            // TTS 完成事件（上游服务器发送）
            logger.info('[projection] ✅ 收到 TTS 完成事件 (tts/done)');
            try {
                const ctx = (global as any).__cordis_ctx;
                if (ctx) {
                    ctx.emit('projection/tts/end', {});
                    logger.info('[projection] ✅ 已转发 TTS 完成事件到前端');
                }
            } catch (e) {
                logger.error('传播 TTS 完成事件失败: %s', (e as Error).message);
            }
            break;
        }
        
        default:
            logger.debug?.('未处理的事件: %s', event);
    }
}

export function startConnecting(ctx?: Context) {
    const url = buildWebSocketUrl();
    if (!url) {
        logger.error('未配置上游服务器地址（server），无法连接');
        return () => {};
    }

    let WS: any;
    try {
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请安装依赖 "ws" 后重试。');
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
        if (reconnectTimer) return; // 已经安排了重连
        const nextDelay = Math.min(retryDelay, 30000);
        logger.info('将在 %ds 后重试连接...', Math.round(nextDelay / 1000));
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!stopped) connect();
        }, nextDelay);
        retryDelay = Math.min(nextDelay * 2, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (connecting) { logger.debug?.('已有连接尝试进行中，跳过本次 connect'); return; }
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) {
            logger.debug?.('当前连接尚未关闭，跳过本次 connect');
            return;
        }
        connecting = true;
        logger.info('尝试连接上游：%s', url.replace(/token=[^&]+/, 'token=***'));
        
        // 清除之前的超时器（如果有）
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        
        // 添加连接超时处理
        connectTimeout = setTimeout(() => {
            if (ws && ws.readyState !== WS.OPEN && ws.readyState !== WS.CLOSED) {
                logger.error('连接超时（30秒）');
                try { ws.close(); } catch { /* ignore */ }
                connecting = false;
                scheduleReconnect();
            }
            connectTimeout = null;
        }, 30000);
        
        try {
            ws = new WS(url);
        } catch (e) {
            logger.error('创建 WebSocket 连接失败: %s', (e as Error).message);
            connecting = false;
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            scheduleReconnect();
            return;
        }
        
        ws.on('open', () => {
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            logger.info('✅ 已连接到上游服务器');
            retryDelay = 3000; // 重置退避
            connecting = false;
            setGlobalWsConnection(ws);
            
            // 订阅 TTS 音频和 Agent 内容事件
            sendEvent(ws, 'subscribe', 'tts/audio');
            sendEvent(ws, 'subscribe', 'tts/started'); // 上游服务器使用 tts/started
            sendEvent(ws, 'subscribe', 'tts/done'); // 上游服务器使用 tts/done
            sendEvent(ws, 'subscribe', 'agent/content');
            sendEvent(ws, 'subscribe', 'agent/content/start');
            sendEvent(ws, 'subscribe', 'agent/content/end');
            sendEvent(ws, 'subscribe', 'agent/message');
        });
        
        ws.on('message', async (data: any) => {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            
            // 处理心跳（文本格式）
            if (text === 'ping' || text.trim() === 'ping') {
                try { 
                    ws.send('pong'); 
                } catch { /* ignore */ }
                return;
            }
            
            // 处理 JSON 消息
            try {
                const msg = JSON.parse(text);
                
                // 处理心跳响应（JSON 格式）
                if (msg.type === 'pong' || (msg.key === 'pong')) {
                    logger.debug?.('收到心跳响应');
                    return;
                }
                
                // 处理 Cordis 事件系统响应
                if (msg.ok === 1 && msg.event) {
                    logger.debug?.('订阅成功: %s', msg.event);
                    subscribedEvents.add(msg.event);
                    return;
                }
                
                // 处理事件格式消息（新协议）
                if (msg.key === 'publish' && msg.event && msg.payload) {
                    handleEventMessage(ws, msg);
                } else if (msg.event && msg.payload) {
                    handleEventMessage(ws, msg);
                }
            } catch (e) {
                // 非 JSON 消息，可能是 ping/pong，不记录
                logger.debug?.('收到非 JSON 消息: %s', text.substring(0, 100));
            }
        });

        ws.on('close', (code: number, reason: Buffer) => {
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            logger.warn('上游连接关闭（code=%s, reason=%s）', code, reason?.toString?.() || '');
            connecting = false;
            setGlobalWsConnection(null);
            scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            logger.error('上游连接错误：%s', err.message);
            connecting = false;
            setGlobalWsConnection(null);
            try { ws.close(); } catch { /* ignore */ }
            scheduleReconnect();
        });
    };

    connect();

    return () => {
        stopped = true;
        
        // 清理定时器
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        
        // 关闭 WebSocket 连接
        if (ws) {
            try {
                ws.removeAllListeners();
                if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) {
                    ws.close(1000, 'shutdown');
                }
            } catch { /* ignore */ }
            ws = null;
        }
        
        setGlobalWsConnection(null);
    };
}

/**
 * 订阅事件（供外部模块使用）
 */
export function subscribeEvent(event: string) {
    const ws = getGlobalWsConnection();
    if (ws) {
        sendEvent(ws, 'subscribe', event);
        subscribedEvents.add(event);
    }
}

/**
 * 取消订阅事件（供外部模块使用）
 */
export function unsubscribeEvent(event: string) {
    const ws = getGlobalWsConnection();
    if (ws) {
        sendEvent(ws, 'unsubscribe', event);
        subscribedEvents.delete(event);
    }
}

/**
 * 发布事件（供外部模块使用）
 */
export function publishEvent(event: string, payload: any[] = []) {
    const ws = getGlobalWsConnection();
    if (ws) {
        sendEvent(ws, 'publish', event, payload);
    }
}

/**
 * 发送回合信息到上游，触发 Agent 响应
 */
export function sendRoundInfo(roundData: any) {
    const ws = getGlobalWsConnection();
    if (!ws || ws.readyState !== 1) {
        logger.warn('WebSocket 未连接，无法发送回合信息');
        return;
    }
    
    try {
        // 使用 client/agent/trigger 事件主动触发 Agent
        sendEvent(ws, 'publish', 'client/agent/trigger', [roundData]);
        logger.info('已发送回合信息到上游（触发 Agent）: round=%s', roundData?.round || 'N/A');
    } catch (e) {
        logger.error('发送回合信息失败: %s', (e as Error).message);
    }
}

