// @ts-nocheck
import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import path from 'node:path';
import { fs, randomstring, Logger } from '../utils';
import { config, saveConfig } from '../config';
import { getGlobalWsConnection } from '../client/client';

const logger = new Logger('client-ui');

const randomHash = randomstring(8).toLowerCase();

// 提供Client UI的HTML页面
class ClientUIHomeHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        const context = {
            secretRoute: '',
            contest: { id: 'client-mode', name: 'Client Dashboard' },
        };
        if (this.request.headers.accept === 'application/json') {
            this.response.body = context;
        } else {
            this.response.type = 'text/html';
            // 在生产模式下，从 /client-ui/main.js 加载
            // 检查构建文件是否存在，如果不存在则提示需要构建
            const bundlePath = path.resolve(__dirname, '../data/static.client-ui');
            const hasBundle = fs.existsSync(bundlePath);
            const scriptPath = hasBundle ? `/client-ui/main.js?${randomHash}` : '/main.js';
            const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Client Dashboard - @Ejunz/agent-edge</title></head><body><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script src="${scriptPath}"></script></body></html>`;
            this.response.body = html;
        }
    }
}

// 提供Client UI的静态JS bundle
class ClientUIStaticHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        this.response.addHeader('Cache-Control', 'public');
        this.response.addHeader('Expires', new Date(new Date().getTime() + 86400000).toUTCString());
        this.response.type = 'text/javascript';
        // Serve built frontend bundle if available, otherwise fallback
        try {
            const bundlePath = path.resolve(__dirname, '../data/static.client-ui');
            if (fs.existsSync(bundlePath)) {
                this.response.body = fs.readFileSync(bundlePath, 'utf-8');
            } else {
                this.response.body = 'console.log("Client UI bundle not found. Please run `yarn build:ui` in packages/server/client/ui.")';
            }
        } catch (e) {
            this.response.body = 'console.log("Failed to load Client UI bundle.")';
        }
    }
}

// 客户端配置 API
class ClientConfigHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    
    async get() {
        try {
            // 从内存中的 config 对象读取
            const voiceConfig = (config as any).voice || {};
            const vtuberConfig = voiceConfig.vtuber || {};
            const vtsConfig = vtuberConfig.vtubestudio || {};
            
            const clientConfig = {
                server: (config as any).server || '',
                port: (config as any).port || 5283,
                vtuber: {
                    enabled: vtuberConfig.enabled !== false,
                    vtubestudio: {
                        host: vtsConfig.host || '127.0.0.1',
                        port: vtsConfig.port || 8001,
                        enabled: vtuberConfig.enabled !== false && vtuberConfig.engine === 'vtubestudio',
                    },
                },
            };
            
            this.response.type = 'application/json';
            this.response.body = { config: clientConfig };
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
    
    async post() {
        try {
            const newConfig = this.request.body;
            
            if (!newConfig || typeof newConfig !== 'object') {
                this.response.status = 400;
                this.response.body = { error: '无效的配置数据' };
                return;
            }
            
            // 更新内存中的 config 对象
            if (typeof newConfig.server === 'string') {
                (config as any).server = newConfig.server;
            }
            if (typeof newConfig.port === 'number') {
                (config as any).port = newConfig.port;
            }
            
            // 更新 VTube Studio 配置
            if (newConfig.vtuber) {
                if (!(config as any).voice) (config as any).voice = {};
                if (!(config as any).voice.vtuber) (config as any).voice.vtuber = {};
                
                const vtuber = (config as any).voice.vtuber;
                if (typeof newConfig.vtuber.enabled === 'boolean') {
                    vtuber.enabled = newConfig.vtuber.enabled;
                }
                
                if (newConfig.vtuber.vtubestudio) {
                    if (!vtuber.vtubestudio) vtuber.vtubestudio = {};
                    const vts = vtuber.vtubestudio;
                    if (typeof newConfig.vtuber.vtubestudio.host === 'string') {
                        vts.host = newConfig.vtuber.vtubestudio.host;
                    }
                    if (typeof newConfig.vtuber.vtubestudio.port === 'number') {
                        vts.port = newConfig.vtuber.vtubestudio.port;
                    }
                    // vtubestudio.enabled 只用于控制是否使用 vtubestudio 引擎
                    // 不影响 vtuber.enabled（主开关）
                    if (typeof newConfig.vtuber.vtubestudio.enabled === 'boolean') {
                        if (newConfig.vtuber.vtubestudio.enabled) {
                            vtuber.engine = 'vtubestudio';
                        } else if (vtuber.engine === 'vtubestudio') {
                            // 如果关闭 vtubestudio，且当前引擎是 vtubestudio，则禁用整个 vtuber
                            vtuber.enabled = false;
                        }
                    }
                }
            }
            
            // 保存到文件
            saveConfig();
            
            this.response.type = 'application/json';
            this.response.body = { success: true, config: {
                server: (config as any).server,
                port: (config as any).port,
                vtuber: (config as any).voice?.vtuber || {},
            } };
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

// 重新加载配置（重新连接上游服务器）
class ClientConfigReloadHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    
    async post() {
        try {
            // 如果请求体中有配置，先更新并保存
            if (this.request.body && typeof this.request.body === 'object') {
                const newConfig = this.request.body;
                if (typeof newConfig.server === 'string') {
                    (config as any).server = newConfig.server;
                }
                if (typeof newConfig.port === 'number') {
                    (config as any).port = newConfig.port;
                }
                
                // 更新 VTube Studio 配置
                if (newConfig.vtuber) {
                    if (!(config as any).voice) (config as any).voice = {};
                    if (!(config as any).voice.vtuber) (config as any).voice.vtuber = {};
                    
                    const vtuber = (config as any).voice.vtuber;
                    if (typeof newConfig.vtuber.enabled === 'boolean') {
                        vtuber.enabled = newConfig.vtuber.enabled;
                    }
                    
                    if (newConfig.vtuber.vtubestudio) {
                        if (!vtuber.vtubestudio) vtuber.vtubestudio = {};
                        const vts = vtuber.vtubestudio;
                        if (typeof newConfig.vtuber.vtubestudio.host === 'string') {
                            vts.host = newConfig.vtuber.vtubestudio.host;
                        }
                        if (typeof newConfig.vtuber.vtubestudio.port === 'number') {
                            vts.port = newConfig.vtuber.vtubestudio.port;
                        }
                        // vtubestudio.enabled 只用于控制是否使用 vtubestudio 引擎
                        // 不影响 vtuber.enabled（主开关）
                        if (typeof newConfig.vtuber.vtubestudio.enabled === 'boolean') {
                            if (newConfig.vtuber.vtubestudio.enabled) {
                                vtuber.engine = 'vtubestudio';
                            } else if (vtuber.engine === 'vtubestudio') {
                                // 如果关闭 vtubestudio，且当前引擎是 vtubestudio，则禁用整个 vtuber
                                vtuber.enabled = false;
                            }
                        }
                    }
                }
                
                // 保存到文件
                saveConfig();
            }
            
            // 通过 Service 重新加载配置
            await this.ctx.inject(['client'], async (c) => {
                const svc = c.client;
                if (svc && typeof svc.reloadConfig === 'function') {
                    await svc.reloadConfig();
                    this.response.type = 'application/json';
                    this.response.body = { success: true, message: '配置已保存并重新加载' };
                } else {
                    this.response.status = 500;
                    this.response.body = { error: 'Client 服务未初始化' };
                }
            });
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

// 前端 WebSocket 连接处理器（复用后端到上游的连接）
class ClientUIWebSocketHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private upstreamMessageHandler: ((data: any) => void) | null = null;
    private upstreamCloseHandler: (() => void) | null = null;
    private upstreamOpenHandler: (() => void) | null = null;
    private checkInterval: NodeJS.Timeout | null = null;
    
    async prepare() {
        logger.debug('[前端WS] 前端 WebSocket 已连接');
        
        // 尝试连接上游，如果未就绪则等待
        const tryConnect = () => {
            const upstreamWs = getGlobalWsConnection();
            if (!upstreamWs || upstreamWs.readyState !== 1) {
                // 上游未就绪，发送状态消息给前端
                this.send({ type: 'status', message: '等待上游连接...' });
                return false;
            }
            
            // 上游已就绪，开始转发
            logger.debug('[前端WS] 上游连接已就绪，开始转发消息');
            this.send({ type: 'status', message: '已连接' });
            
            // 转发上游消息到前端
            this.upstreamMessageHandler = (data: any) => {
                try {
                    // 如果是 Buffer，转换为字符串
                    let message: string;
                    if (Buffer.isBuffer(data)) {
                        message = data.toString();
                    } else if (typeof data === 'string') {
                        message = data;
                    } else {
                        message = JSON.stringify(data);
                    }
                    
                    // 记录所有收到的消息（用于调试）
                    logger.debug('[前端WS] 收到上游消息，原始长度: %d', message.length);
                    
                    // 检查是否是 TTS 音频消息，添加调试日志
                    try {
                        const parsed = JSON.parse(message);
                        
                        // 记录所有消息（用于调试）
                        if (parsed.event === 'tts/audio') {
                            logger.debug('[前端WS] 收到 TTS 音频事件，准备转发到前端');
                            logger.debug('[前端WS] 消息格式: key=%s, event=%s, payload长度=%d', 
                                parsed.key || 'N/A', 
                                parsed.event, 
                                parsed.payload?.length || 0);
                            if (parsed.payload && parsed.payload[0] && parsed.payload[0].audio) {
                                logger.debug('[前端WS] 音频数据长度: %d 字节', parsed.payload[0].audio.length);
                            }
                        } else if (parsed.key === 'publish' && parsed.event) {
                            logger.debug('[前端WS] 转发事件到前端: %s', parsed.event);
                        }
                        
                        // 确保消息格式正确（保留原始格式）
                        // 如果消息有 key 字段，保留它；如果没有，保持原样
                        this.send(parsed);
                        
                        if (parsed.event === 'tts/audio') {
                            logger.debug('[前端WS] TTS 音频数据已发送到前端');
                        }
                    } catch (parseErr) {
                        // 如果不是 JSON，直接发送字符串
                        logger.debug('[前端WS] 转发非 JSON 消息到前端: %s', (parseErr as Error).message);
                        this.send(message);
                    }
                } catch (e) {
                    logger.error('[前端WS] 转发上游消息到前端失败: %s', (e as Error).message);
                }
            };
            
            // 监听上游消息
            logger.debug('[前端WS] 注册上游消息监听器');
            upstreamWs.on('message', this.upstreamMessageHandler);
            
            // 测试：发送一个测试消息确认监听器工作
            logger.debug('[前端WS] 监听器已注册，等待上游消息...');
            
            // 清理：当上游连接关闭时，通知前端
            this.upstreamCloseHandler = () => {
                this.send({ type: 'status', message: '上游连接已断开' });
            };
            upstreamWs.on('close', this.upstreamCloseHandler);
            upstreamWs.on('error', this.upstreamCloseHandler);
            
            // 监听上游连接重新打开
            this.upstreamOpenHandler = () => {
                logger.debug('[前端WS] 上游连接已重新打开');
                this.send({ type: 'status', message: '已连接' });
            };
            upstreamWs.on('open', this.upstreamOpenHandler);
            
            return true;
        };
        
        // 立即尝试连接
        if (!tryConnect()) {
            // 如果未就绪，每 500ms 检查一次，最多等待 10 秒
            let attempts = 0;
            const maxAttempts = 20; // 10秒 / 500ms = 20次
            this.checkInterval = setInterval(() => {
                attempts++;
                if (tryConnect()) {
                    if (this.checkInterval) {
                        clearInterval(this.checkInterval);
                        this.checkInterval = null;
                    }
                } else if (attempts >= maxAttempts) {
                    // 超时，通知前端
                    this.send({ type: 'status', message: '上游连接超时' });
                    if (this.checkInterval) {
                        clearInterval(this.checkInterval);
                        this.checkInterval = null;
                    }
                }
            }, 500);
        }
    }
    
    // 接收前端消息并转发到上游
    async message(msg: any) {
        const upstreamWs = getGlobalWsConnection();
        if (!upstreamWs || upstreamWs.readyState !== 1) {
            return;
        }
        
        try {
            // 将消息转换为字符串发送到上游
            const message = typeof msg === 'string' ? msg : JSON.stringify(msg);
            upstreamWs.send(message);
        } catch (e) {
            logger.error('[前端WS] 转发前端消息到上游失败: %s', (e as Error).message);
        }
    }
    
    async cleanup() {
        // 清除检查间隔
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        // 移除上游监听器
        const upstreamWs = getGlobalWsConnection();
        if (upstreamWs) {
            if (this.upstreamMessageHandler) {
                upstreamWs.removeListener('message', this.upstreamMessageHandler);
            }
            if (this.upstreamCloseHandler) {
                upstreamWs.removeListener('close', this.upstreamCloseHandler);
                upstreamWs.removeListener('error', this.upstreamCloseHandler);
            }
            if (this.upstreamOpenHandler) {
                upstreamWs.removeListener('open', this.upstreamOpenHandler);
            }
        }
        logger.debug('[前端WS] 前端 WebSocket 已断开');
    }
}

export async function apply(ctx: Context) {
    // 只在client模式下注册（通过检查是否有 --client 参数或配置文件）
    const isClientMode = process.argv.includes('--client') || 
                         (process.env.CLIENT_MODE === 'true') ||
                         fs.existsSync(path.resolve(__dirname, '../../config.client.yaml'));
    
    if (isClientMode) {
        ctx.Route('client-ui-home', '/client-ui', ClientUIHomeHandler);
        ctx.Route('client-ui-static', '/client-ui/main.js', ClientUIStaticHandler);
        ctx.Route('client-config', '/api/client-config', ClientConfigHandler);
        ctx.Route('client-config-reload', '/api/client-config/reload', ClientConfigReloadHandler);
        ctx.Connection('client-ui-ws', '/client-ws', ClientUIWebSocketHandler);
    }
}

