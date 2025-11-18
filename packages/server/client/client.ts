import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import { VoiceClient } from './voice';
import { listClientTools, callClientTool, ClientToolDefinition } from '../mcp-tools/client';
import crypto from 'node:crypto';

const logger = new Logger('client');

// 全局语音客户端实例
let globalVoiceClient: VoiceClient | null = null;

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
 * 发送旧格式消息（向后兼容）
 */
function sendLegacyMessage(ws: any, type: string, data: any = {}) {
    if (!ws || ws.readyState !== 1) {
        logger.warn('WebSocket 未连接，无法发送消息: %s', type);
        return;
    }
    
    const message = {
        type,
        ...data,
    };
    
    try {
        ws.send(JSON.stringify(message));
        logger.debug?.('发送旧格式消息: %s', type);
    } catch (e) {
        logger.error('发送消息失败: %s', (e as Error).message);
    }
}

/**
 * 处理事件格式消息（新协议）
 */
function handleEventMessage(ws: any, msg: any) {
    const { event, payload } = msg;
    
    switch (event) {
        case 'asr/result': {
            const [result] = payload || [];
            if (result) {
                logger.info('📝 ASR 结果: %s (isFinal: %s)', result.text, result.isFinal);
                // 转发给 voice-auto 处理
                try {
                    const { handleRealtimeAsrMessage } = require('./voice-auto');
                    if (handleRealtimeAsrMessage) {
                        handleRealtimeAsrMessage({
                            type: 'conversation.item.input_audio_transcription.completed',
                            transcript: result.text,
                            isFinal: result.isFinal,
                        });
                    }
                } catch (e: any) {
                    logger.debug('转发 ASR 结果到 voice-auto 失败: %s', e.message);
                }
                // 也转发给语音客户端处理
                if (globalVoiceClient) {
                    (globalVoiceClient as any).handleMessage?.(JSON.stringify({
                        type: 'asr/result',
                        text: result.text,
                        isFinal: result.isFinal,
                    }));
                }
            }
            break;
        }
        
        case 'asr/sentence_begin': {
            logger.debug('ASR 句子开始');
            // 转发给 voice-auto 处理
            try {
                const { handleRealtimeAsrMessage } = require('./voice-auto');
                if (handleRealtimeAsrMessage) {
                    handleRealtimeAsrMessage({
                        type: 'input_audio_buffer.speech_started',
                    });
                }
            } catch (e: any) {
                logger.debug('转发 ASR 句子开始到 voice-auto 失败: %s', e.message);
            }
            break;
        }
        
        case 'asr/sentence_end': {
            logger.debug('ASR 句子结束');
            // 转发给 voice-auto 处理
            try {
                const { handleRealtimeAsrMessage } = require('./voice-auto');
                if (handleRealtimeAsrMessage) {
                    handleRealtimeAsrMessage({
                        type: 'input_audio_buffer.speech_stopped',
                    });
                }
            } catch (e: any) {
                logger.debug('转发 ASR 句子结束到 voice-auto 失败: %s', e.message);
            }
            break;
        }
        
        case 'asr/error': {
            const [error] = payload || [];
            logger.error('ASR 错误: %s', error?.message || error);
            // 转发给 voice-auto 处理
            try {
                const { handleRealtimeAsrMessage } = require('./voice-auto');
                if (handleRealtimeAsrMessage) {
                    handleRealtimeAsrMessage({
                        type: 'error',
                        error: { message: error?.message || error || 'ASR 错误' },
                    });
                }
            } catch (e: any) {
                logger.debug('转发 ASR 错误到 voice-auto 失败: %s', e.message);
            }
            if (globalVoiceClient) {
                globalVoiceClient.emit('error', new Error(error?.message || error || 'ASR 错误'));
            }
            break;
        }
        
        case 'tts/audio': {
            const [audioData] = payload || [];
            if (audioData?.audio) {
                logger.debug('收到 TTS 音频数据');
                // 转发给语音客户端处理
                if (globalVoiceClient) {
                    (globalVoiceClient as any).handleMessage?.(JSON.stringify({
                        type: 'tts/audio',
                        audio: audioData.audio,
                    }));
                }
                // 注意：消息会继续传播到其他监听器（如 ClientUIWebSocketHandler）
                // 不需要在这里转发，因为 upstreamMessageHandler 会收到原始消息
            }
            break;
        }
        
        case 'tts/error': {
            const [error] = payload || [];
            logger.error('TTS 错误: %s', error?.message || error);
            if (globalVoiceClient) {
                globalVoiceClient.emit('error', new Error(error?.message || error || 'TTS 错误'));
            }
            break;
        }
        
        case 'tts/done': {
            logger.debug('TTS 音频生成完成');
            // 可以在这里处理 TTS 完成后的逻辑（如通知前端播放完成）
            if (globalVoiceClient) {
                (globalVoiceClient as any).handleMessage?.(JSON.stringify({
                    type: 'tts/done',
                }));
            }
            break;
        }
        
        // 新协议：等待 TTS 播放事件
        case 'agent/wait_tts_playback': {
            logger.debug('Agent 等待 TTS 播放（服务器通知客户端开始播放）');
            // 事件会自动传播到其他监听器（如 ClientUIWebSocketHandler）
            break;
        }
        
        // 新协议：核心 message 事件（事件流队列）
        case 'agent/message': {
            const [message] = payload || [];
            if (message) {
                logger.debug('Agent Message: %s (type: %s)', message.messageId, message.type);
                if (message.type === 'audio') {
                    logger.debug('Audio Message - content: %s', message.content?.substring(0, 50) || 'N/A');
                } else if (message.type === 'toolcall') {
                    logger.debug('Toolcall Message - tool: %s', message.toolName || 'N/A');
                }
            }
            // 事件会自动传播到其他监听器（如 ClientUIWebSocketHandler）
            break;
        }
        
        // 新协议：消息级别事件
        case 'agent/message/start': {
            logger.debug('Agent 消息开始（整个对话轮次开始）');
            break;
        }
        
        case 'agent/message/end': {
            logger.debug('Agent 消息结束（整个对话轮次结束）');
            break;
        }
        
        // 新协议：内容输出阶段事件
        case 'agent/content/start': {
            logger.debug('Agent 内容输出开始（寒暄阶段开始）');
            break;
        }
        
        case 'client/agent/content_start':
        case 'agent/content_start': {
            // 向后兼容旧格式
            logger.debug('Agent 开始输出内容（旧格式）');
            break;
        }
        
        case 'client/agent/content':
        case 'agent/content': {
            const [content] = payload || [];
            if (content) {
                logger.debug('Agent 内容流式输出: %s', content);
                // 可以在这里处理流式内容
            }
            break;
        }
        
        case 'agent/content/end': {
            const [contentData] = payload || [];
            const content = typeof contentData === 'string' ? contentData : contentData?.content;
            logger.debug('Agent 内容输出结束（寒暄阶段结束）: %s', content?.substring(0, 50) || 'N/A');
            break;
        }
        
        case 'client/agent/content_complete':
        case 'agent/content_complete': {
            // 向后兼容旧格式
            logger.debug('Agent 内容输出完成（旧格式）');
            break;
        }
        
        // 新协议：工具调用阶段事件
        case 'agent/tool_call/start': {
            const [toolData] = payload || [];
            const toolName = typeof toolData === 'string' ? toolData : toolData?.toolName;
            logger.debug('Agent 工具调用开始: %s', toolName || 'N/A');
            break;
        }
        
        case 'client/agent/tool_call_start':
        case 'agent/tool_call_start': {
            // 向后兼容旧格式
            logger.debug('Agent 开始调用工具（旧格式）');
            break;
        }
        
        case 'client/agent/tool_call':
        case 'agent/tool_call': {
            const [toolData] = payload || [];
            const tools = toolData?.tools || (Array.isArray(toolData) ? toolData : []);
            logger.debug('Agent 工具调用: %s', JSON.stringify(tools));
            break;
        }
        
        case 'agent/tool_call/end': {
            const [toolData] = payload || [];
            const toolName = typeof toolData === 'string' ? toolData : toolData?.toolName;
            logger.debug('Agent 工具调用结束: %s', toolName || 'N/A');
            break;
        }
        
        case 'client/agent/tool_call_complete':
        case 'agent/tool_call_complete': {
            // 向后兼容旧格式
            logger.debug('Agent 工具调用完成（旧格式）');
            break;
        }
        
        case 'client/agent/tool_result':
        case 'agent/tool_result': {
            const [resultData] = payload || [];
            const tool = resultData?.tool || resultData?.toolName;
            logger.debug('Agent 工具结果: %s - %s', tool || 'N/A', JSON.stringify(resultData?.result || resultData).substring(0, 100));
            break;
        }
        
        case 'client/agent/thinking':
        case 'agent/thinking': {
            logger.debug('Agent 正在思考');
            break;
        }
        
        case 'client/agent/done':
        case 'agent/done': {
            const [doneData] = payload || [];
            const message = typeof doneData === 'string' ? doneData : doneData?.message;
            logger.info('Agent 对话完成: %s', message || '');
            break;
        }
        
        case 'client/agent/error':
        case 'agent/error': {
            const [errorData] = payload || [];
            const error = typeof errorData === 'string' ? errorData : (errorData?.message || errorData);
            logger.error('Agent 错误: %s', error);
            break;
        }
        
        default:
            logger.debug?.('未处理的事件: %s', event);
    }
}

/**
 * 处理旧格式消息（向后兼容）
 */
function handleLegacyMessage(ws: any, msg: any) {
    const { type } = msg;
    
    switch (type) {
        case 'pong': {
            logger.debug?.('收到心跳响应');
            break;
        }
        
        case 'asr/started': {
            logger.info('ASR 已启动');
            break;
        }
        
        case 'asr/result': {
            logger.info('📝 ASR 结果: %s (isFinal: %s)', msg.text, msg.isFinal);
            // 转发给语音客户端处理
            if (globalVoiceClient) {
                (globalVoiceClient as any).handleMessage?.(JSON.stringify(msg));
            }
            break;
        }
        
        case 'asr/sentence_begin': {
            logger.debug('ASR 句子开始');
            break;
        }
        
        case 'asr/sentence_end': {
            logger.debug('ASR 句子结束');
            break;
        }
        
        case 'asr/error': {
            logger.error('ASR 错误: %s', msg.message);
            if (globalVoiceClient) {
                globalVoiceClient.emit('error', new Error(msg.message || 'ASR 错误'));
            }
            break;
        }
        
        case 'asr/stopped': {
            logger.info('ASR 已停止');
            break;
        }
        
        case 'tts/started': {
            logger.info('TTS 已启动');
            break;
        }
        
        case 'tts/audio': {
            logger.debug('收到 TTS 音频数据');
            // 转发给语音客户端处理
            if (globalVoiceClient) {
                (globalVoiceClient as any).handleMessage?.(JSON.stringify(msg));
            }
            break;
        }
        
        case 'tts/error': {
            logger.error('TTS 错误: %s', msg.message);
            if (globalVoiceClient) {
                globalVoiceClient.emit('error', new Error(msg.message || 'TTS 错误'));
            }
            break;
        }
        
        case 'tts/stopped': {
            logger.info('TTS 已停止');
            break;
        }
        
        case 'agent/content_start': {
            logger.debug('Agent 开始输出内容');
            break;
        }
        
        case 'agent/content': {
            logger.debug('Agent 内容: %s', msg.content);
            break;
        }
        
        case 'agent/content_complete': {
            logger.debug('Agent 内容输出完成');
            break;
        }
        
        case 'agent/tool_call_start': {
            logger.debug('Agent 开始调用工具');
            break;
        }
        
        case 'agent/tool_call': {
            logger.debug('Agent 工具调用: %s', JSON.stringify(msg.tools));
            break;
        }
        
        case 'agent/tool_call_complete': {
            logger.debug('Agent 工具调用完成');
            break;
        }
        
        case 'agent/tool_result': {
            logger.debug('Agent 工具结果: %s', JSON.stringify(msg));
            break;
        }
        
        case 'agent/thinking': {
            logger.debug('Agent 正在思考');
            break;
        }
        
        case 'agent/done': {
            logger.info('Agent 对话完成: %s', msg.message || '');
            break;
        }
        
        case 'agent/error': {
            logger.error('Agent 错误: %s', msg.message);
            break;
        }
        
        case 'status/update': {
            logger.debug('状态更新: %s', JSON.stringify(msg.client));
            break;
        }
        
        default:
            // 转发给语音客户端处理（兼容旧协议）
            if (globalVoiceClient) {
                (globalVoiceClient as any).handleMessage?.(JSON.stringify(msg));
            }
    }
}

export function startConnecting(ctx?: Context) {
    const url = buildWebSocketUrl();
    if (!url) {
        logger.warn('未配置上游，跳过主动连接。请在 client 配置中设置 server（或 domainId + wsToken）或通过环境变量 EDGE_UPSTREAM 指定。');
        return () => {};
    }

    let WS: any;
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
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
        logger.info('尝试连接上游：%s', url);
        
        // 清除之前的超时器（如果有）
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        
        // 添加连接超时处理（与握手超时时间匹配）
        connectTimeout = setTimeout(() => {
            if (ws && ws.readyState !== WS.OPEN && ws.readyState !== WS.CLOSED) {
                logger.error('连接超时（10秒），可能是服务器未响应或 WebSocket 端点不存在');
                logger.error('提示：请确保服务器已启动（yarn dev:server），并且 WebSocket 端点 /edge/conn 可用');
                try { ws.close(); } catch { /* ignore */ }
                connecting = false;
                scheduleReconnect();
            }
            connectTimeout = null;
        }, 18000); // 比握手超时稍长
        
        // Windows 上可能需要更长的超时时间，或者使用不同的配置
        const wsOptions: any = {
            handshakeTimeout: 15000, // 增加到15秒
            perMessageDeflate: false, // 禁用压缩，可能有助于 Windows 兼容性
            // 添加超时重试相关选项
            maxReconnects: 0, // 不使用自动重连，我们自己处理
        };
        
        // 在 Windows 上，尝试不同的配置
        if (process.platform === 'win32') {
            // Windows 上可能需要不同的配置
            // 移除 agent，使用原生 socket
            wsOptions.agent = undefined;
            
            logger.debug('[Windows] WebSocket 连接 URL: %s', url);
        }
        
        ws = new WS(url, wsOptions);

        ws.on('open', () => {
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            logger.info('上游连接已建立：%s', url);
            retryDelay = 3000; // 重置退避
            connecting = false;
            globalWsConnection = ws; // 保存全局 WebSocket 连接（在连接建立后立即设置）
            
            // 发送心跳（使用新协议格式）
            try {
                ws.send(JSON.stringify({ key: 'ping' }));
            } catch { /* ignore */ }
            
            // 自动订阅常用事件
            const autoSubscribeEvents = [
                'asr/result',
                'asr/sentence_begin',
                'asr/sentence_end',
                'asr/error',
                'tts/audio',
                'tts/error',
                // 新协议：核心事件
                'agent/message',
                'agent/message/start',
                'agent/message/end',
                'agent/wait_tts_playback',
                // 新协议：内容输出阶段
                'agent/content/start',
                'agent/content',
                'agent/content/end',
                // 新协议：工具调用阶段
                'agent/tool_call/start',
                'agent/tool_call',
                'agent/tool_call/end',
                'agent/tool_result',
                'agent/done',
                'agent/error',
                // 向后兼容旧格式
                'client/agent/content_start',
                'client/agent/content',
                'client/agent/content_complete',
                'client/agent/tool_call_start',
                'client/agent/tool_call',
                'client/agent/tool_call_complete',
                'client/agent/tool_result',
                'client/agent/thinking',
                'client/agent/done',
                'client/agent/error',
            ];
            
            // 延迟订阅，确保连接完全就绪
            setTimeout(() => {
                autoSubscribeEvents.forEach(event => {
                    sendEvent(ws, 'subscribe', event);
                    subscribedEvents.add(event);
                });
                
                // 向上游发送工具列表（使用 Edge Envelope 协议，类似 node 的方式）
                try {
                    const tools = listClientTools(true);
                    const toolsPayload = tools.map((t: ClientToolDefinition) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        metadata: t.metadata || {},
                    }));
                    
                    // 使用 Edge Envelope 协议发送工具通知
                    const envelope = {
                        protocol: 'mcp',
                        action: 'jsonrpc',
                        payload: {
                            jsonrpc: '2.0',
                            method: 'notifications/tools-update',
                            params: {
                                tools: toolsPayload,
                                reason: 'bootstrap',
                                timestamp: Date.now(),
                            },
                            id: `tools_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
                        },
                    };
                    
                    ws.send(JSON.stringify(envelope));
                    logger.info('已向上游发送 %d 个 MCP 工具（使用 Edge Envelope 协议）', tools.length);
                    if (tools.length > 0) {
                        logger.info('工具列表: %s', tools.map(t => t.name).join(', '));
                    }
                } catch (e) {
                    logger.warn('发送工具列表失败: %s', (e as Error).message);
                }
            }, 100);
            
            // 上游连接成功后，先启动 VTube Studio 并等待认证完成，然后再启动其他服务
            // 延迟一点时间，确保 WebSocket 完全就绪
            setTimeout(async () => {
                try {
                    const config = require('../config').config as any;
                    const voiceConfig = config.voice || {};
                    const vtuberConfig = voiceConfig.vtuber || {};
                    
                    // 先启动 VTube Studio（如果启用）
                    // 检查主开关和引擎类型（只有当 enabled 明确为 true 时才启动）
                    if (vtuberConfig.enabled === true && vtuberConfig.engine === 'vtubestudio') {
                        const { startVTuberServer } = require('./vtuber-server');
                        const { waitForVTubeStudioAuthentication } = require('./vtuber-vtubestudio');
                        
                        if (startVTuberServer) {
                            logger.info('上游连接已稳定，启动 VTube Studio 控制...');
                            // 传递 Context 以便访问数据库
                            await startVTuberServer(ctx);
                            
                            // 等待 VTube Studio 认证完成（最多等待 30 秒，包括可能需要用户手动授权的情况）
                            logger.info('等待 VTube Studio 认证完成（最多 30 秒，如需授权请尽快在 VTube Studio 中确认）...');
                            const authenticated = await waitForVTubeStudioAuthentication(30000);
                            
                            if (authenticated) {
                                logger.info('✓ VTube Studio 认证完成，继续初始化其他服务');
                            } else {
                                logger.warn('⚠️  VTube Studio 认证未完成（30秒超时），继续启动其他服务');
                                logger.warn('提示：如果这是首次连接，请确保已在 VTube Studio 中授权此插件');
                            }
                        } else {
                            logger.warn('startVTuberServer 函数不存在');
                        }
                    } else if (vtuberConfig.enabled !== false && vtuberConfig.engine === 'osc') {
                        // 初始化 OSC 桥接器（如果启用）
                        if (vtuberConfig.osc?.enabled) {
                            try {
                                const { initOSCBridge } = require('./vtuber-osc-bridge');
                                initOSCBridge(vtuberConfig.osc.host, vtuberConfig.osc.port);
                                logger.info('VTuber OSC 桥接器已启动: %s:%d', vtuberConfig.osc.host, vtuberConfig.osc.port);
                            } catch (err: any) {
                                logger.debug('启动 OSC 桥接器失败: %s', err.message);
                            }
                        }
                    } else {
                        logger.debug('VTuber 功能已禁用');
                    }
                    
                    // VTube Studio 初始化完成，准备启动语音监听服务
                    logger.info('VTube Studio 初始化完成，准备启动语音监听服务...');
                    
                } catch (err: any) {
                    logger.error('启动VTuber控制服务器失败: %s', err.message);
                    logger.error(err.stack);
                    
                    // 即使失败也继续启动语音服务
                    logger.info('继续启动语音监听服务...');
                }
            }, 100); // 延迟 100ms，确保 WebSocket 消息路由完全就绪
            
            // 初始化语音客户端（不阻塞，可以在后台运行）
            globalVoiceClient = new VoiceClient({ ws });
            globalVoiceClient.on('error', (err: Error) => {
                logger.error('语音客户端错误: %s', err.message);
            });
            globalVoiceClient.on('response', (data: any) => {
                logger.info('收到语音回复');
            });
        });
        
        // 添加连接状态变化日志
        ws.on('upgrade', () => {
            logger.debug('WebSocket 握手中...');
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
                // 支持两种格式：
                // 1. { key: 'publish', event: 'tts/audio', payload: [...] }
                // 2. { event: 'tts/audio', payload: [...] }
                if (msg.key === 'publish' && msg.event && msg.payload) {
                    if (msg.event === 'tts/audio') {
                        logger.debug('[client] 收到 TTS 音频事件（将传播到前端）');
                    }
                    handleEventMessage(ws, msg);
                    // 注意：不要 return，让消息继续传播到其他监听器（如 ClientUIWebSocketHandler）
                    // 这样 upstreamMessageHandler 也能收到这个消息并转发到前端
                } else if (msg.event && msg.payload) {
                    handleEventMessage(ws, msg);
                    // 同样不 return，让消息继续传播
                }
                
                // 处理旧格式消息（向后兼容）
                if (msg.type) {
                    handleLegacyMessage(ws, msg);
                    return;
                }
                
                // VTube Studio 认证令牌相关的消息需要被其他模块处理，这里只记录
                if (msg.key === 'vtuber_auth_token_get' || msg.key === 'vtuber_auth_token_save') {
                    logger.debug('收到 VTube Studio 认证令牌消息: %s', msg.key);
                    // 不在这里处理，让其他模块的监听器处理
                    return;
                }
                
                // 处理 MCP 工具请求（使用 Edge Envelope 协议，类似 node 的方式）
                // 检查是否是 Edge Envelope 格式
                if (msg.protocol === 'mcp' && msg.action === 'jsonrpc' && msg.payload) {
                    const payload = msg.payload;
                    const id = payload.id ?? null;
                    const method = payload.method;
                    const traceId = msg.traceId;
                    
                    const reply = (body: any) => {
                        // 使用和 node 完全一致的格式（包括 direction 和 meta）
                        const replyEnvelope: any = {
                            protocol: 'mcp',
                            action: 'jsonrpc',
                            direction: 'outbound',
                            payload: {
                                jsonrpc: '2.0',
                                id,
                                ...body,
                            },
                        };
                        // 如果有traceId，需要包含在envelope中（类似node的方式）
                        if (traceId) {
                            replyEnvelope.traceId = traceId;
                        }
                        // 添加 meta 字段（类似 node 的方式）
                        replyEnvelope.meta = {};
                        try {
                            const envelopeStr = JSON.stringify(replyEnvelope);
                            logger.debug('[MCP响应] 发送响应: id=%s, traceId=%s, 长度=%d', id, traceId || 'none', envelopeStr.length);
                            ws.send(envelopeStr);
                            logger.debug('[MCP响应] 响应已发送: id=%s', id);
                        } catch (e) {
                            logger.error('[MCP响应] 发送 MCP 响应失败: id=%s, 错误: %s', id, (e as Error).message);
                        }
                    };
                    
                    if (method === 'tools/list') {
                        const tools = listClientTools(true);
                        reply({ result: { tools } });
                        return;
                    }
                    
                    if (method === 'tools/call') {
                        const { name, arguments: args } = payload.params || {};
                        logger.info('[MCP工具调用] 收到请求: %s, 参数: %o, id: %s', name, args, id);
                        try {
                            const result = await callClientTool(ctx, { name, arguments: args || {} });
                            // MCP协议要求返回格式：{ content: [{ type: 'text', text: ... }] }
                            const mcpResult = {
                                content: [{
                                    type: 'text',
                                    text: JSON.stringify(result)
                                }]
                            };
                            logger.info('[MCP工具调用] 准备返回结果: %s, id: %s', name, id);
                            reply({ result: mcpResult });
                            logger.info('[MCP工具调用] 已发送响应: %s, id: %s', name, id);
                        } catch (e) {
                            logger.error('[MCP工具调用] 工具调用失败: %s, 错误: %s, id: %s', name, (e as Error).message, id);
                            reply({ error: { code: -32603, message: (e as Error).message } });
                        }
                        return;
                    }
                }
                
                // 兼容旧的消息格式
                if (msg.key === 'tools/list' || (msg.method === 'tools/list')) {
                    const tools = listClientTools(true);
                    try {
                        ws.send(JSON.stringify({
                            key: 'tools/list',
                            result: { tools },
                        }));
                    } catch (e) {
                        logger.warn('发送工具列表失败: %s', (e as Error).message);
                    }
                    return;
                }
                
                if (msg.key === 'tools/call' || (msg.method === 'tools/call')) {
                    const { name, arguments: args } = msg.params || msg;
                    try {
                        const result = await callClientTool(ctx, { name, arguments: args || {} });
                        try {
                            ws.send(JSON.stringify({
                                key: 'tools/call',
                                result,
                            }));
                        } catch (e) {
                            logger.warn('发送工具调用结果失败: %s', (e as Error).message);
                        }
                    } catch (e) {
                        logger.error('工具调用失败: %s', (e as Error).message);
                        try {
                            ws.send(JSON.stringify({
                                key: 'tools/call',
                                error: { code: -32603, message: (e as Error).message },
                            }));
                        } catch {}
                    }
                    return;
                }
                
                // 其他 key 消息（旧协议）
                if (msg.key && msg.key !== 'voice_chat_audio') {
                    logger.debug?.('上游消息：key=%s', msg.key);
                    // 转发给语音客户端处理
                    if (globalVoiceClient) {
                        (globalVoiceClient as any).handleMessage?.(data);
                    }
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
            scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            logger.error('上游连接错误：%s', err.message);
            // 提供更详细的错误信息
            if (err.message.includes('ECONNREFUSED')) {
                logger.error('连接被拒绝，请确保服务器已启动（运行 yarn dev:server）');
            } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
                logger.error('无法解析主机名，请检查配置中的 server 地址');
            } else if (err.message.includes('timeout') || err.message.includes('handshake')) {
                logger.error('WebSocket 握手超时，可能是：');
                logger.error('  1. 服务器未正确启动或 WebSocket 端点 /edge/conn 不存在');
                logger.error('  2. Windows 防火墙阻止了连接');
                logger.error('  3. 端口被其他程序占用');
                logger.error('请检查服务器终端日志中是否有 "Edge client connected" 的记录');
            }
            connecting = false;
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
                ws.removeAllListeners(); // 移除所有监听器，避免内存泄漏
                if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) {
                    ws.close(1000, 'shutdown');
                }
            } catch { /* ignore */ }
            ws = null;
        }
        
        // 清理语音客户端
        if (globalVoiceClient) {
            try {
                globalVoiceClient.removeAllListeners();
            } catch { /* ignore */ }
            globalVoiceClient = null;
        }
    };
}

// 导出语音客户端访问接口
export function getVoiceClient(): VoiceClient | null {
    return globalVoiceClient;
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
 * ASR 协议：开始 ASR
 */
export function startASR() {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/asr/start', []);
    }
}

/**
 * ASR 协议：发送音频数据
 */
export function sendASRAudio(audioBase64: string) {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/asr/audio', [{ audio: audioBase64 }]);
    }
}

/**
 * ASR 协议：停止 ASR
 */
export function stopASR() {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/asr/stop', []);
    }
}

/**
 * TTS 协议：开始 TTS
 */
export function startTTS() {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/tts/start', []);
    }
}

/**
 * TTS 协议：发送文本
 */
export function sendTTSText(text: string) {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/tts/text', [{ text }]);
    }
}

/**
 * TTS 协议：停止 TTS
 */
export function stopTTS() {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/tts/stop', []);
    }
}

/**
 * Agent 协议：发送对话消息
 */
export function sendAgentChat(message: string, history: Array<{ role: string; content: string }> = []) {
    const ws = getGlobalWsConnection();
    if (ws) {
        // 优先使用新协议格式
        sendEvent(ws, 'publish', 'client/agent/chat', [{ message, history }]);
    }
}

// 全局变量，用于存储 dispose 函数（用于向后兼容）
let globalDispose: (() => void) | null = null;
    
// 优雅关闭处理（保留用于进程退出时的清理）
    const cleanup = () => {
        try {
        if (globalDispose) globalDispose();
        } catch (err: any) {
            logger.error('清理客户端连接失败: %s', err.message);
        }
        // 强制退出，避免进程挂起
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    };
    
    // Windows 上也需要监听这些信号
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    
    // Windows 上的 Ctrl+C 会触发 SIGINT，但有时需要直接监听
    if (process.platform === 'win32') {
        // Windows 上监听关闭事件
        process.on('exit', () => {
            try {
            if (globalDispose) globalDispose();
            } catch { /* ignore */ }
        });
}


