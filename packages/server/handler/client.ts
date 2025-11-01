import { ConnectionHandler, Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';

const logger = new Logger('edge2client');

class ClientAliveHandler extends Handler<Context> {
    async get() {
        this.response.body = { ok: 1 };
    }
}

type Subscription = {
    event: string;
    dispose: () => void;
};

export class ClientConnectionHandler extends ConnectionHandler<Context> {
    static active = new Set<ClientConnectionHandler>();
    private pending: Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout } > = new Map();
    private subscriptions: Subscription[] = [];
    private accepted = false;
    conversationHistory: Array<{ role: string; content: string }> = []; // 对话历史

    async prepare() {
        // 允许多个客户端连接（移除单例限制以支持语音客户端等）
        // 如果确实需要单例限制，可以通过配置控制
        const allowMultiple = true; // 可以通过配置读取
        if (!allowMultiple && ClientConnectionHandler.active.size > 0) {
            try { this.close(1000, 'edge singleton: connection already active'); } catch { /* ignore */ }
            return;
        }
        this.accepted = true;
        logger.info('Edge client connected from %s (active connections: %d)', this.request.ip, ClientConnectionHandler.active.size + 1);
        this.send({ hello: 'edge', version: 1 });
        ClientConnectionHandler.active.add(this);
        // 延迟到连接完全就绪（onmessage 已挂载）后再请求，避免竞态
        setTimeout(() => {
            if (!this.accepted) return;
            this.sendRpc('tools/list', undefined, 1500).then((tools) => {
                logger.info('Edge tools: %o', tools);
            }).catch((e) => {
                logger.warn('Fetch tools/list failed: %s', (e as Error).message);
            });
        }, 150);
    }

    private unsubscribeAll() {
        for (const sub of this.subscriptions) {
            try { sub.dispose?.(); } catch { /* ignore */ }
        }
        this.subscriptions = [];
    }

    async message(msg: any) {
        // Prefer handling JSON-RPC objects (framework already JSON.parse on message)
        if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.id !== undefined) {
            const rec = this.pending.get(String(msg.id));
            if (rec) {
                this.pending.delete(String(msg.id));
                clearTimeout(rec.timer);
                if ('error' in msg && msg.error) rec.reject(msg.error);
                else rec.resolve(msg.result);
                return;
            }
        }
        if (!msg || typeof msg !== 'object') return;
        const { key } = msg;
        switch (key) {
        case 'publish': {
            // publish to app event bus
            const { event, payload } = msg;
            if (typeof event === 'string') {
                try {
                    const args = [event, ...(Array.isArray(payload) ? payload : [payload])];
                    (global as any).__cordis_ctx.parallel.apply((global as any).__cordis_ctx, args);
                } catch (e) {
                    logger.warn('publish failed: %s', (e as Error).message);
                }
            }
            break; }
        case 'subscribe': {
            const { event } = msg;
            if (typeof event === 'string') {
                const handler = (...args: any[]) => {
                    try { this.send({ event, payload: args }); } catch { /* ignore */ }
                };
                const dispose = (global as any).__cordis_ctx.on(event as any, handler as any);
                this.subscriptions.push({ event, dispose });
                this.send({ ok: 1, event });
            }
            break; }
        case 'unsubscribe': {
            const { event } = msg;
            if (typeof event === 'string') {
                const rest: Subscription[] = [];
                for (const sub of this.subscriptions) {
                    if (sub.event === event) {
                        try { sub.dispose?.(); } catch { /* ignore */ }
                    } else rest.push(sub);
                }
                this.subscriptions = rest;
                this.send({ ok: 1, event });
            }
            break; }
        case 'vtuber_auth_token_save': {
            // 保存 VTube Studio 认证令牌到数据库
            const { host, port, authToken } = msg;
            if (!host || !port) {
                this.send({ key: 'vtuber_auth_token_save', error: '缺少 host 或 port' });
                return;
            }
            
            try {
                const db = (this.ctx as any).db;
                if (!db || !db.vtuberAuthToken) {
                    this.send({ key: 'vtuber_auth_token_save', error: '数据库未初始化' });
                    return;
                }
                
                const docId = `${host}:${port}`;
                const now = Date.now();
                
                // 查找是否已存在
                const existing = await db.vtuberAuthToken.findOne({ _id: docId });
                
                if (existing) {
                    // 更新现有记录
                    await db.vtuberAuthToken.update(
                        { _id: docId },
                        { $set: { authToken: authToken || '', updatedAt: now } }
                    );
                } else {
                    // 创建新记录
                    await db.vtuberAuthToken.insert({
                        _id: docId,
                        host,
                        port,
                        authToken: authToken || '',
                        updatedAt: now,
                        createdAt: now,
                    });
                }
                
                this.send({ key: 'vtuber_auth_token_save', ok: 1, saved: !!authToken });
            } catch (err: any) {
                logger.error('保存 VTube Studio 认证令牌失败: %s', err.message);
                this.send({ key: 'vtuber_auth_token_save', error: err.message });
            }
            break; }
        case 'vtuber_auth_token_get': {
            // 从数据库读取 VTube Studio 认证令牌
            const { host, port } = msg;
            if (!host || !port) {
                this.send({ key: 'vtuber_auth_token_get', error: '缺少 host 或 port' });
                return;
            }
            
            try {
                const db = (this.ctx as any).db;
                if (!db || !db.vtuberAuthToken) {
                    this.send({ key: 'vtuber_auth_token_get', error: '数据库未初始化' });
                    return;
                }
                
                const docId = `${host}:${port}`;
                const doc = await db.vtuberAuthToken.findOne({ _id: docId });
                
                if (doc && doc.authToken) {
                    this.send({ key: 'vtuber_auth_token_get', ok: 1, authToken: doc.authToken });
                } else {
                    this.send({ key: 'vtuber_auth_token_get', ok: 1, authToken: null });
                }
            } catch (err: any) {
                logger.error('读取 VTube Studio 认证令牌失败: %s', err.message);
                this.send({ key: 'vtuber_auth_token_get', error: err.message });
            }
            break; }
        case 'voice_chat': {
            // 完整语音对话流程：接收音频或文本 -> AI -> TTS -> 返回音频
            const { audio, text, format = 'wav', conversationHistory = [] } = msg;
            
            // 支持两种模式：1. 音频模式（需要ASR） 2. 文本模式（实时ASR已识别完成）
            if (!audio && !text) {
                this.send({ key: 'voice_chat', error: '缺少音频数据或文本数据' });
                return;
            }
            
            try {
                // 使用this.ctx访问服务（ConnectionHandler继承的context）
                const voiceService = (this.ctx as any).voice;
                if (!voiceService) {
                    this.send({ key: 'voice_chat', error: '语音服务未初始化' });
                    return;
                }
                
                let result: any;
                
                if (text) {
                    // 文本模式：直接从AI对话开始（实时ASR已完成转录）
                    logger.info('收到文本消息，直接进行AI对话: %s', text);
                    const aiResponse = await voiceService.chat(text, conversationHistory);
                    
                    // 检查是否使用realtime TTS（支持流式播放）
                    const voiceConfig = (config as any).voice || {};
                    const ttsConfig = voiceConfig.tts || {};
                    const model = ttsConfig.model || 'qwen3-tts-flash';
                    
                    if (model.includes('realtime')) {
                        // 使用流式TTS：先发送初始消息，然后流式发送音频分片
                        logger.info('使用流式TTS模式');
                        
                        // 先发送文本和AI回复（客户端会自己随机选择动画）
                        this.send({
                            key: 'voice_chat',
                            result: {
                                text: text,
                                aiResponse: aiResponse,
                                audio: null, // 音频将通过流式分片发送
                                streaming: true, // 标识这是流式传输
                            },
                        });
                        
                        // 然后流式发送音频
                        try {
                            await (voiceService as any).streamTtsRealtime(
                                aiResponse,
                                { ...ttsConfig, voice: ttsConfig.voice || 'Cherry' },
                                (audioChunk: Buffer) => {
                                    // 每收到一个音频分片，立即发送给客户端
                                    this.send({
                                        key: 'voice_chat_audio',
                                        chunk: audioChunk.toString('base64'),
                                    });
                                }
                            );
                            
                            // 发送流式传输完成信号
                            this.send({
                                key: 'voice_chat_audio',
                                done: true,
                            });
                        } catch (e: any) {
                            logger.error('流式TTS失败，回退到非流式模式: %s', e.message);
                            // 回退到非流式模式
                            const audioBuffer = await voiceService.tts(aiResponse);
                            this.send({
                                key: 'voice_chat',
                                result: {
                                    text: text,
                                    audio: audioBuffer.toString('base64'),
                                    aiResponse: aiResponse,
                                },
                            });
                        }
                    } else {
                        // 非流式TTS：等待完整音频后发送（客户端会自己随机选择动画）
                        const audioBuffer = await voiceService.tts(aiResponse);
                        
                        result = {
                            text: text,
                            audio: audioBuffer.toString('base64'),
                            aiResponse: aiResponse,
                        };
                        
                        // 返回结果
                        this.send({
                            key: 'voice_chat',
                            result: result,
                        });
                    }
                } else {
                    // 音频模式：ASR -> AI -> TTS
                    const audioBuffer = Buffer.from(audio, 'base64');
                    logger.info('收到语音消息，音频大小: %d bytes', audioBuffer.length);
                    result = await voiceService.voiceChat(audioBuffer, format, conversationHistory);
                    
                    // 客户端会自己随机选择动画（音频模式）
                    result.audio = result.audio.toString('base64');
                    
                    // 返回结果
                    this.send({
                        key: 'voice_chat',
                        result: result,
                    });
                }
            } catch (e: any) {
                logger.error('语音对话处理失败: %s', e.message);
                this.send({ key: 'voice_chat', error: e.message });
            }
            break; }
        case 'voice_asr': {
            // ASR: 语音转文字
            const { audio, format = 'wav' } = msg;
            if (!audio) {
                this.send({ key: 'voice_asr', error: '缺少音频数据' });
                return;
            }
            try {
                const voiceService = (this.ctx as any).voice;
                if (!voiceService) {
                    this.send({ key: 'voice_asr', error: '语音服务未初始化' });
                    return;
                }
                const audioBuffer = Buffer.from(audio, 'base64');
                const text = await voiceService.asr(audioBuffer, format);
                this.send({ key: 'voice_asr', result: { text } });
            } catch (e: any) {
                logger.error('ASR处理失败: %s', e.message);
                this.send({ key: 'voice_asr', error: e.message });
            }
            break; }
        case 'voice_tts': {
            // TTS: 文字转语音
            const { text, voice } = msg;
            if (!text) {
                this.send({ key: 'voice_tts', error: '缺少文本数据' });
                return;
            }
            try {
                const voiceService = (this.ctx as any).voice;
                if (!voiceService) {
                    this.send({ key: 'voice_tts', error: '语音服务未初始化' });
                    return;
                }
                const audio = await voiceService.tts(text, voice);
                this.send({ key: 'voice_tts', result: { audio: audio.toString('base64') } });
            } catch (e: any) {
                logger.error('TTS处理失败: %s', e.message);
                this.send({ key: 'voice_tts', error: e.message });
            }
            break; }
        case 'ping':
            this.send('pong');
            break;
        default:
            // echo back for unknown keys
            this.send({ ok: 1, echo: msg });
        }
    }

    async cleanup() {
        this.unsubscribeAll();
        if (this.accepted) logger.info('Edge client disconnected from %s', this.request.ip);
        for (const [, p] of this.pending) { try { p.reject(new Error('connection closed')); } catch { /* ignore */ } }
        this.pending.clear();
        ClientConnectionHandler.active.delete(this);
    }

    // Send JSON-RPC to this client
    sendRpc(method: string, params?: any, timeoutMs = 20000): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('edge rpc timeout'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('edge_alive', '/edge', ClientAliveHandler);
    ctx.Connection('edge_conn', '/edge/conn', ClientConnectionHandler);
}