import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import { VoiceClient } from './voice';

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

function normalizeUpstreamFromHost(host: string): string {
    if (!host) return '';
    
    // 如果已经是完整的 WebSocket URL（包含路径），直接返回
    if (/^wss?:\/\//i.test(host)) {
        try {
            const url = new URL(host);
            // 如果 URL 已经包含路径（不只是根路径），直接返回
            if (url.pathname && url.pathname !== '/') {
                return host;
            }
            // 如果只有根路径，添加 /edge/conn
            return new URL('/edge/conn', host).toString();
        } catch {
            // URL 解析失败，尝试直接使用
            return host;
        }
    }
    
    // 支持用户把 host 写成完整 HTTP/HTTPS URL
    if (/^https?:\/\//i.test(host)) {
        const base = host.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
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
    return `wss://${host}/edge/conn`;
}

function resolveUpstream(): string | null {
    const fromServer = normalizeUpstreamFromHost((config as any).server || '');
    const target = fromServer || process.env.EDGE_UPSTREAM || '';
    return target || null;
}

export function startConnecting(ctx?: Context) {
    const url = resolveUpstream();
    if (!url) {
        logger.warn('未配置上游，跳过主动连接。请在 client 配置中设置 server 或通过环境变量 EDGE_UPSTREAM 指定。');
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
            try { ws.send('{"key":"ping"}'); } catch { /* ignore */ }
            
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
                            await startVTuberServer(); // 等待数据库加载完成
                            
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
            if (text === 'ping') {
                try { ws.send('pong'); } catch { /* ignore */ }
                return;
            }
            // 处理可能的 JSON-RPC 响应或其他消息
            try {
                const msg = JSON.parse(text);
                // VTube Studio 认证令牌相关的消息需要被其他模块处理，这里只记录
                if (msg.key === 'vtuber_auth_token_get' || msg.key === 'vtuber_auth_token_save') {
                    logger.debug('收到 VTube Studio 认证令牌消息: %s', msg.key);
                    // 不在这里处理，让其他模块的监听器处理
                    return;
                }
                if (msg.key && msg.key !== 'voice_chat_audio') {
                    // 只记录非音频消息的 key
                    logger.debug?.('上游消息：key=%s', msg.key);
                }
                // voice_chat_audio 消息太多，不记录
            } catch {
                // 非 JSON 消息，可能是 ping/pong，不记录
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


