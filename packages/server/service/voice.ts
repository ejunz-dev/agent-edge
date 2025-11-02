import { Context, Service } from 'cordis';
import superagent from 'superagent';
import { config } from '../config';
import { Logger } from '../utils';
import { callTool, listTools } from '../mcp-tools';

const logger = new Logger('voice');

export interface IVoiceService {
    asr(audioData: Buffer | string, format?: string): Promise<string>;
    tts(text: string, voice?: string): Promise<Buffer>;
    chat(message: string, conversationHistory?: Array<{ role: string; content: string }>): Promise<string>;
    chatStream(message: string, conversationHistory?: Array<{ role: string; content: string }>, onChunk?: (chunk: string) => void): Promise<string>;
    chatStreamWithTts(
        message: string, 
        conversationHistory?: Array<{ role: string; content: string }>, 
        onAudioChunk?: (chunk: Buffer) => void,
        onTextChunk?: (chunk: string) => void,
        useCache?: boolean
    ): Promise<string | { text: string; audioId?: string }>;
}

// 音频缓存接口
interface AudioCacheEntry {
    audioChunks: Buffer[];
    totalLength: number;
    createdAt: number;
    status: 'generating' | 'ready' | 'error';
    error?: string;
}

class VoiceService extends Service implements IVoiceService {
    logger = this.ctx.logger('voice')
    
    // 音频缓存：audioId -> AudioCacheEntry
    private audioCache = new Map<string, AudioCacheEntry>();
    private readonly CACHE_EXPIRE_TIME = 5 * 60 * 1000; // 5分钟过期
    private readonly CACHE_CLEANUP_INTERVAL = 60 * 1000; // 每分钟清理一次过期缓存
    
    // 暴露流式TTS方法供handler调用（公共方法）
    async streamTtsRealtime(text: string, ttsConfig: any, onAudioChunk: (chunk: Buffer) => void): Promise<void> {
        return await this.qwenTtsRealtimeStream(text, ttsConfig, onAudioChunk);
    }
    private voiceConfig: any;

    constructor(ctx: Context) {
        super(ctx, 'voice');
        this.voiceConfig = (config as any).voice || {};
        
        // 启动缓存清理定时器
        setInterval(() => {
            this.cleanupExpiredCache();
        }, this.CACHE_CLEANUP_INTERVAL);
    }
    
    // 清理过期缓存
    private cleanupExpiredCache() {
        const now = Date.now();
        let cleaned = 0;
        for (const [audioId, entry] of this.audioCache.entries()) {
            if (now - entry.createdAt > this.CACHE_EXPIRE_TIME) {
                this.audioCache.delete(audioId);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.logger.debug(`[AudioCache] 清理了${cleaned}个过期缓存项`);
        }
    }
    
    // 创建音频缓存并返回ID（公开方法，供handler提前创建）
    createAudioCache(): string {
        const audioId = `audio_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        this.audioCache.set(audioId, {
            audioChunks: [],
            totalLength: 0,
            createdAt: Date.now(),
            status: 'generating'
        });
        this.logger.debug(`[AudioCache] 创建缓存: ${audioId}`);
        return audioId;
    }
    
    // 添加音频块到缓存
    private appendAudioToCache(audioId: string, chunk: Buffer) {
        const entry = this.audioCache.get(audioId);
        if (!entry) {
            this.logger.warn(`[AudioCache] 缓存不存在: ${audioId}`);
            return;
        }
        entry.audioChunks.push(chunk);
        entry.totalLength += chunk.length;
        this.logger.debug(`[AudioCache] 添加音频块到缓存: ${audioId}, chunk大小: ${chunk.length}, 总大小: ${entry.totalLength}`);
    }
    
    // 标记缓存为就绪
    private markCacheReady(audioId: string) {
        const entry = this.audioCache.get(audioId);
        if (!entry) {
            this.logger.warn(`[AudioCache] 缓存不存在: ${audioId}`);
            return;
        }
        entry.status = 'ready';
        this.logger.info(`[AudioCache] 缓存就绪: ${audioId}, 总大小: ${entry.totalLength} bytes`);
    }
    
    // 标记缓存为错误
    private markCacheError(audioId: string, error: string) {
        const entry = this.audioCache.get(audioId);
        if (!entry) {
            this.logger.warn(`[AudioCache] 缓存不存在: ${audioId}`);
            return;
        }
        entry.status = 'error';
        entry.error = error;
        this.logger.error(`[AudioCache] 缓存错误: ${audioId}, ${error}`);
    }
    
    // 获取缓存状态
    getAudioCacheStatus(audioId: string): { status: string; totalLength: number; error?: string } | null {
        const entry = this.audioCache.get(audioId);
        if (!entry) {
            return null;
        }
        return {
            status: entry.status,
            totalLength: entry.totalLength,
            error: entry.error
        };
    }
    
    // 获取缓存音频（流式读取）
    // 支持在generating状态下返回已有数据（用于边缓存边播放）
    *getAudioCacheStream(audioId: string, allowGenerating: boolean = false): Generator<Buffer> {
        const entry = this.audioCache.get(audioId);
        if (!entry) {
            throw new Error(`音频缓存不存在: ${audioId}`);
        }
        
        if (entry.status === 'error') {
            throw new Error(entry.error || '音频生成失败');
        }
        
        // 如果允许generating状态，或者状态是ready，返回数据
        if (entry.status === 'ready' || (allowGenerating && entry.status === 'generating')) {
            // 流式返回所有音频块
            for (const chunk of entry.audioChunks) {
                yield chunk;
            }
        } else {
            throw new Error(`音频尚未就绪: ${entry.status}`);
        }
    }
    
    // 删除缓存
    deleteAudioCache(audioId: string) {
        const deleted = this.audioCache.delete(audioId);
        if (deleted) {
            this.logger.debug(`[AudioCache] 删除缓存: ${audioId}`);
        }
        return deleted;
    }

    [Service.init]() {
        this.logger.info('Voice service initialized');
        if (this.voiceConfig.asr?.provider) {
            this.logger.info(`ASR provider: ${this.voiceConfig.asr.provider}`);
        }
        if (this.voiceConfig.tts?.provider) {
            this.logger.info(`TTS provider: ${this.voiceConfig.tts.provider}`);
        }
        if (this.voiceConfig.ai?.provider) {
            this.logger.info(`AI provider: ${this.voiceConfig.ai.provider}`);
        }
    }

    /**
     * ASR: 语音转文字
     */
    async asr(audioData: Buffer | string, format = 'wav'): Promise<string> {
        const asrConfig = this.voiceConfig.asr || {};
        if (!asrConfig.provider || !asrConfig.apiKey) {
            throw new Error('ASR未配置：请设置 voice.asr.provider 和 voice.asr.apiKey');
        }

        const provider = asrConfig.provider.toLowerCase();
        const endpoint = asrConfig.endpoint || 'https://api.openai.com/v1/audio/transcriptions';
        const model = asrConfig.model || 'whisper-1';

        try {
            if (provider === 'openai') {
                // 处理base64字符串或Buffer
                let audioBuffer: Buffer;
                if (typeof audioData === 'string') {
                    // 假设是base64编码
                    audioBuffer = Buffer.from(audioData, 'base64');
                } else {
                    audioBuffer = audioData;
                }

                const response = await superagent
                    .post(endpoint)
                    .set('Authorization', `Bearer ${asrConfig.apiKey}`)
                    .attach('file', audioBuffer, `audio.${format}`)
                    .field('model', model);

                const result = response.body;
                return result.text || '';
            } else if (provider === 'qwen' || provider === 'qwen-realtime') {
                // Qwen ASR（文件上传版本）
                // 注意：qwen-realtime主要用于实时流式（在client端），这里是server端处理文件上传
                let audioBuffer: Buffer;
                if (typeof audioData === 'string') {
                    audioBuffer = Buffer.from(audioData, 'base64');
                } else {
                    audioBuffer = audioData;
                }

                // 对于qwen-realtime配置，如果是文件上传，可能需要转换格式或使用临时存储
                // 这里先尝试使用Qwen的ASR API（如果支持文件上传）
                // 或者提示用户应该使用实时ASR
                if (provider === 'qwen-realtime') {
                    throw new Error('qwen-realtime是实时流式ASR，应在client端使用实时连接。server端处理文件上传请使用provider: qwen（如果Qwen支持文件上传）或openai');
                }

                // Qwen非实时ASR API（如果有）
                const qwenEndpoint = asrConfig.endpoint || 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
                const qwenModel = asrConfig.model || 'qwen-asr';

                try {
                    // 尝试文件上传方式
                    const response = await superagent
                        .post(qwenEndpoint)
                        .set('Authorization', `Bearer ${asrConfig.apiKey}`)
                        .attach('audio', audioBuffer, `audio.${format}`)
                        .field('model', qwenModel);

                    const result = response.body;
                    if (result.output && result.output.text) {
                        return result.output.text;
                    } else if (result.text) {
                        return result.text;
                    }
                } catch (e: any) {
                    // 如果文件上传失败，尝试base64方式
                    const response = await superagent
                        .post(qwenEndpoint)
                        .set('Authorization', `Bearer ${asrConfig.apiKey}`)
                        .set('Content-Type', 'application/json')
                        .send({
                            model: qwenModel,
                            audio: audioBuffer.toString('base64'),
                        });

                    const result = response.body;
                    if (result.output && result.output.text) {
                        return result.output.text;
                    } else if (result.text) {
                        return result.text;
                    }
                }

                throw new Error('Qwen ASR API响应格式未知');
            } else if (provider === 'custom') {
                // 自定义端点
                let audioBuffer: Buffer;
                if (typeof audioData === 'string') {
                    audioBuffer = Buffer.from(audioData, 'base64');
                } else {
                    audioBuffer = audioData;
                }

                const response = await superagent
                    .post(endpoint)
                    .set('Authorization', `Bearer ${asrConfig.apiKey}`)
                    .attach('file', audioBuffer, `audio.${format}`);

                return response.body.text || response.text || '';
            } else {
                throw new Error(`不支持的ASR provider: ${provider}`);
            }
        } catch (error: any) {
            this.logger.error('ASR转换失败: %s', error.message);
            throw new Error(`ASR转换失败: ${error.message}`);
        }
    }

    /**
     * TTS: 文字转语音
     */
    async tts(text: string, voice?: string): Promise<Buffer> {
        const ttsConfig = this.voiceConfig.tts || {};
        if (!ttsConfig.provider || !ttsConfig.apiKey) {
            throw new Error('TTS未配置：请设置 voice.tts.provider 和 voice.tts.apiKey');
        }

        const provider = ttsConfig.provider.toLowerCase();
        const endpoint = ttsConfig.endpoint || (provider === 'qwen' 
            ? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
            : 'https://api.openai.com/v1/audio/speech');
        const voiceName = voice || ttsConfig.voice || 'alloy';

        try {
            if (provider === 'openai') {
                const response = await superagent
                    .post(endpoint)
                    .set('Authorization', `Bearer ${ttsConfig.apiKey}`)
                    .set('Content-Type', 'application/json')
                    .send({
                        model: 'tts-1',
                        input: text,
                        voice: voiceName,
                    })
                    .responseType('arraybuffer');

                return Buffer.from(response.body);
            } else if (provider === 'qwen') {
                // 阿里云Qwen TTS
                const model = ttsConfig.model || 'qwen3-tts-flash';
                const languageType = ttsConfig.languageType || 'Chinese';
                
                // 检查是否是realtime版本，需要使用WebSocket
                if (model.includes('realtime')) {
                    // realtime版本默认使用流式模式（如果支持）
                    // 这里返回完整Buffer以兼容现有接口
                    // 流式模式通过voiceChatStream方法调用
                    this.logger.info('使用Qwen TTS Realtime（WebSocket模式）');
                    return await this.qwenTtsRealtime(text, { ...ttsConfig, voice: voiceName });
                }
                
                // 标准HTTP调用（flash版本）
                // Qwen TTS API调用
                const requestBody = {
                    model,
                    input: {
                        text,
                        voice: voiceName,
                        language_type: languageType,
                    },
                };

                // Qwen TTS调用
                // 不设置responseType，让superagent自动处理
                const ttsResponse = await superagent
                    .post(endpoint)
                    .set('Authorization', `Bearer ${ttsConfig.apiKey}`)
                    .set('Content-Type', 'application/json')
                    // 暂时不启用SSE，先尝试标准HTTP响应
                    // .set('X-DashScope-SSE', 'enable') // 启用SSE以支持流式响应
                    .send(requestBody);

                // 记录响应信息用于调试
                const contentType = ttsResponse.headers['content-type'] || '';
                this.logger.info('TTS响应Content-Type: %s', contentType);
                this.logger.info('TTS响应状态: %s', ttsResponse.status);
                this.logger.info('TTS响应body类型: %s', typeof ttsResponse.body);
                
                // 检查响应类型
                if (contentType.includes('application/json')) {
                    // JSON格式响应
                    let jsonResponse: any;
                    
                    // 处理不同类型的body
                    if (Buffer.isBuffer(ttsResponse.body)) {
                        // 如果是Buffer，转换为字符串再解析
                        const text = ttsResponse.body.toString('utf8');
                        this.logger.debug('TTS JSON响应（Buffer转字符串）: %s', text.substring(0, 200));
                        jsonResponse = JSON.parse(text);
                    } else if (typeof ttsResponse.body === 'string') {
                        // 如果是字符串，直接解析
                        this.logger.debug('TTS JSON响应（字符串）: %s', ttsResponse.body.substring(0, 200));
                        jsonResponse = JSON.parse(ttsResponse.body);
                    } else if (typeof ttsResponse.body === 'object' && ttsResponse.body !== null) {
                        // 如果已经是对象（superagent自动解析了JSON）
                        jsonResponse = ttsResponse.body;
                        this.logger.debug('TTS JSON响应（已解析对象）');
                    } else {
                        // 尝试使用text字段
                        if (ttsResponse.text) {
                            jsonResponse = JSON.parse(ttsResponse.text);
                        } else {
                            throw new Error(`无法解析TTS响应: body类型=${typeof ttsResponse.body}`);
                        }
                    }
                    
                    this.logger.info('TTS JSON响应内容: %s', JSON.stringify(jsonResponse, null, 2));
                    
                    // Qwen TTS响应格式：output.audio可能是对象（包含url和data）或字符串（base64）
                    if (jsonResponse.output && jsonResponse.output.audio) {
                        const audioData = jsonResponse.output.audio;
                        
                        // 如果audio是对象，可能包含url或data字段
                        if (typeof audioData === 'object' && audioData !== null) {
                            if (audioData.url) {
                                // 音频URL，需要再次请求
                                this.logger.info('TTS返回音频URL: %s', audioData.url);
                                const audioResponse = await superagent
                                    .get(audioData.url)
                                    .responseType('arraybuffer');
                                return Buffer.from(audioResponse.body);
                            } else if (audioData.data && typeof audioData.data === 'string') {
                                // base64编码的音频数据
                                this.logger.info('TTS返回base64音频（在data字段），长度: %d', audioData.data.length);
                                return Buffer.from(audioData.data, 'base64');
                            } else {
                                throw new Error(`TTS音频格式错误: audio对象中没有url或data字段`);
                            }
                        } else if (typeof audioData === 'string') {
                            // 直接是base64字符串
                            this.logger.info('TTS返回base64音频（字符串），长度: %d', audioData.length);
                            return Buffer.from(audioData, 'base64');
                        } else {
                            throw new Error(`TTS音频格式错误: audio字段类型=${typeof audioData}`);
                        }
                    } else if (jsonResponse.output && jsonResponse.output.url) {
                        // 兼容旧格式：音频URL直接在output.url
                        this.logger.info('TTS返回音频URL（旧格式）: %s', jsonResponse.output.url);
                        const audioResponse = await superagent
                            .get(jsonResponse.output.url)
                            .responseType('arraybuffer');
                        return Buffer.from(audioResponse.body);
                    } else {
                        this.logger.error('TTS响应中没有找到audio或url字段');
                        this.logger.error('响应结构: %s', JSON.stringify(jsonResponse, null, 2));
                        throw new Error(`Qwen TTS返回格式错误: ${JSON.stringify(jsonResponse)}`);
                    }
                } else {
                    // 二进制音频流或其他格式
                    const audioBuffer = ttsResponse.body;
                    this.logger.info('TTS返回非JSON响应，body类型: %s', typeof audioBuffer);
                    
                    if (Buffer.isBuffer(audioBuffer)) {
                        this.logger.info('TTS返回Buffer，长度: %d bytes', audioBuffer.length);
                        return audioBuffer;
                    } else if (audioBuffer instanceof ArrayBuffer) {
                        this.logger.info('TTS返回ArrayBuffer，长度: %d bytes', audioBuffer.byteLength);
                        return Buffer.from(audioBuffer);
                    } else if (typeof audioBuffer === 'string') {
                        // 可能是base64编码的字符串
                        this.logger.info('TTS返回字符串，长度: %d', audioBuffer.length);
                        return Buffer.from(audioBuffer, 'base64');
                    } else {
                        this.logger.error('TTS响应body类型: %s', typeof audioBuffer);
                        this.logger.error('TTS响应body内容（尝试JSON化）: %s', JSON.stringify(audioBuffer).substring(0, 200));
                        throw new Error(`TTS响应格式不支持: ${typeof audioBuffer}`);
                    }
                }
            } else if (provider === 'custom') {
                // 自定义端点
                const response = await superagent
                    .post(endpoint)
                    .set('Authorization', `Bearer ${ttsConfig.apiKey}`)
                    .set('Content-Type', 'application/json')
                    .send({ text, voice: voiceName })
                    .responseType('arraybuffer');

                return Buffer.from(response.body);
            } else {
                throw new Error(`不支持的TTS provider: ${provider}`);
            }
        } catch (error: any) {
            this.logger.error('TTS转换失败: %s', error.message);
            if (error.response) {
                const errorBody = error.response.body || error.response.text;
                this.logger.error('TTS响应错误: %s', JSON.stringify(errorBody));
                
                // 如果是API Key不支持HTTP调用的错误，提供更友好的提示
                if (errorBody && typeof errorBody === 'object' && errorBody.message && errorBody.message.includes('does not support http call')) {
                    this.logger.error('TTS API Key可能不支持HTTP调用，请检查：');
                    this.logger.error('1. API Key是否正确且有TTS服务的权限');
                    this.logger.error('2. 是否使用了正确的端点（北京/新加坡地域）');
                    this.logger.error('3. 是否需要使用SSE或流式接口');
                }
            }
            throw new Error(`TTS转换失败: ${error.message}`);
        }
    }

    /**
     * AI对话（WebSocket流式版本）
     */
    async chatStream(message: string, conversationHistory: Array<{ role: string; content: string }> = [], onChunk?: (chunk: string) => void): Promise<string> {
        const aiConfig = this.voiceConfig.ai || {};
        if (!aiConfig.provider) {
            throw new Error('AI未配置：请设置 voice.ai.provider');
        }

        const provider = aiConfig.provider.toLowerCase();
        const endpoint = aiConfig.endpoint || 'wss://beta.ejunz.com/api/agent/A4/stream';
        const requestFormat = aiConfig.requestFormat || 'simple';

        // 检查是否为WebSocket URL
        if (!endpoint.startsWith('ws://') && !endpoint.startsWith('wss://')) {
            // 如果不是WebSocket，回退到HTTP方式（用于其他provider）
            return await this.chatHTTP(message, conversationHistory);
        }

        let WS: any;
        try {
            WS = require('ws');
        } catch (e) {
            throw new Error('缺少 ws 依赖，请安装: npm install ws');
        }

        this.logger.debug(`[AI WebSocket] 连接到: ${endpoint}`);

        return new Promise((resolve, reject) => {
            let fullResponse = '';
            let isResolved = false;

            const ws = new WS(endpoint, {
                // 不需要认证，直接连接
            });

            ws.on('open', () => {
                this.logger.debug('[AI WebSocket] 连接已建立');

                // 构建请求消息
                let requestMessage: any;
                if (provider === 'ejunz' || requestFormat === 'simple') {
                    // 简单格式：只发送当前消息
                    requestMessage = { message };
                } else {
                    // OpenAI格式：包含对话历史
                    const messages = [...conversationHistory];
                    messages.push({ role: 'user', content: message });
                    requestMessage = { messages };
                }

                this.logger.debug('[AI WebSocket] 发送消息: %s', JSON.stringify(requestMessage));
                ws.send(JSON.stringify(requestMessage));
            });

            ws.on('message', async (data: Buffer | string) => {
                try {
                    const textData = typeof data === 'string' ? data : data.toString('utf8');
                    this.logger.debug('[AI WebSocket] 收到消息: %s', textData.substring(0, 200));

                    // 尝试解析JSON
                    let json: any;
                    try {
                        json = JSON.parse(textData);
                    } catch {
                        // 如果不是JSON，可能是纯文本流
                        if (textData.trim()) {
                            fullResponse += textData;
                            if (onChunk) {
                                onChunk(textData);
                            }
                        }
                        return;
                    }

                    // 处理不同类型的消息
                    if (json.type === 'text' || json.type === 'content') {
                        // 文本内容
                        const content = json.content || json.text || '';
                        if (content) {
                            fullResponse += content;
                            if (onChunk) {
                                onChunk(content);
                            }
                        }
                    } else if (json.type === 'tool_call' || json.tool_calls || json.toolCall) {
                        // 工具调用请求
                        const toolCalls = json.tool_calls || (json.toolCall ? [json.toolCall] : []);
                        for (const toolCall of toolCalls) {
                            await this.handleToolCall(toolCall, ws);
                        }
                    } else if (json.type === 'done' || json.type === 'finished') {
                        // 完成
                        this.logger.debug('[AI WebSocket] 响应完成');
                        if (!isResolved) {
                            isResolved = true;
                            ws.close();
                            resolve(fullResponse);
                        }
                    } else if (json.message || json.text || json.content) {
                        // 直接包含回复内容
                        const content = json.message || json.text || json.content || '';
                        if (content) {
                            fullResponse += content;
                            if (onChunk) {
                                onChunk(content);
                            }
                        }
                        // 检查是否完成
                        if (json.done || json.finished) {
                            if (!isResolved) {
                                isResolved = true;
                                ws.close();
                                resolve(fullResponse);
                            }
                        }
                    } else if (json.error) {
                        // 错误
                        this.logger.error('[AI WebSocket] 错误: %s', JSON.stringify(json.error));
                        ws.close();
                        if (!isResolved) {
                            isResolved = true;
                            reject(new Error(`AI错误: ${json.error.message || JSON.stringify(json.error)}`));
                        }
                    } else {
                        // 其他类型，尝试提取文本
                        if (typeof json === 'string') {
                            fullResponse += json;
                            if (onChunk) {
                                onChunk(json);
                            }
                        }
                    }
                } catch (e: any) {
                    this.logger.error('[AI WebSocket] 处理消息失败: %s', e.message);
                }
            });

            ws.on('error', (err: Error) => {
                this.logger.error('[AI WebSocket] 连接错误: %s', err.message);
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            });

            ws.on('close', (code: number, reason: Buffer) => {
                this.logger.debug(`[AI WebSocket] 连接关闭: ${code} - ${reason?.toString() || ''}`);
                if (!isResolved) {
                    isResolved = true;
                    resolve(fullResponse);
                }
            });

            // 设置超时
            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    ws.close();
                    if (fullResponse) {
                        resolve(fullResponse);
                    } else {
                        reject(new Error('AI响应超时'));
                    }
                }
            }, 60000); // 60秒超时
        });
    }

    /**
     * 处理工具调用
     */
    private async handleToolCall(toolCall: any, ws: any): Promise<void> {
        try {
            const toolName = toolCall.name || toolCall.function?.name;
            let toolArgs = toolCall.arguments || toolCall.function?.arguments || toolCall.args || {};

            if (!toolName) {
                this.logger.warn('[AI WebSocket] 工具调用缺少名称');
                return;
            }

            // 如果参数是字符串，尝试解析为JSON
            if (typeof toolArgs === 'string') {
                try {
                    toolArgs = JSON.parse(toolArgs);
                } catch {
                    // 如果解析失败，使用原始字符串
                    this.logger.warn('[AI WebSocket] 工具参数不是有效的JSON，使用原始字符串');
                }
            }

            // 确保参数是对象
            if (typeof toolArgs !== 'object' || toolArgs === null) {
                toolArgs = {};
            }

            this.logger.info('[AI WebSocket] 调用工具: %s, 参数: %s', toolName, JSON.stringify(toolArgs));

            // 调用MCP工具
            let result: any;
            try {
                result = await callTool(this.ctx, { name: toolName, arguments: toolArgs });
                this.logger.info('[AI WebSocket] 工具调用成功: %s, 结果: %s', toolName, JSON.stringify(result).substring(0, 200));
            } catch (e: any) {
                this.logger.error('[AI WebSocket] 工具调用失败: %s, 错误: %s', toolName, e.message);
                result = { error: e.message };
            }

            // 发送工具调用结果回AI
            const toolResult = {
                type: 'tool_result',
                tool_call_id: toolCall.id || toolCall.call_id || `call_${Date.now()}`,
                result: result,
            };

            this.logger.debug('[AI WebSocket] 发送工具结果: %s', JSON.stringify(toolResult));
            ws.send(JSON.stringify(toolResult));
        } catch (e: any) {
            this.logger.error('[AI WebSocket] 处理工具调用失败: %s', e.message);
        }
    }

    /**
     * AI对话（HTTP版本，用于非WebSocket endpoint的回退）
     */
    private async chatHTTP(message: string, conversationHistory: Array<{ role: string; content: string }> = []): Promise<string> {
        const aiConfig = this.voiceConfig.ai || {};
        const provider = aiConfig.provider.toLowerCase();
        const endpoint = aiConfig.endpoint || 'https://api.openai.com/v1/chat/completions';
        const model = aiConfig.model || 'gpt-3.5-turbo';
        const authHeader = aiConfig.authHeader || 'Authorization';
        const authPrefix = aiConfig.authPrefix !== undefined ? aiConfig.authPrefix : 'Bearer';
        const requestFormat = aiConfig.requestFormat || 'openai';

        try {
            if (provider === 'openai' || provider === 'custom' || provider === 'ejunz') {
                const request = superagent
                    .post(endpoint)
                    .set('Content-Type', 'application/json');

                // 设置认证Header（如果有）
                if (aiConfig.apiKey) {
                let authValue: string;
                if (authPrefix && authPrefix.trim() !== '') {
                    authValue = `${authPrefix} ${aiConfig.apiKey}`;
                } else {
                    authValue = aiConfig.apiKey;
                }
                authValue = authValue.trim();
                request.set(authHeader, authValue);
                }

                let requestBody: any;
                if (provider === 'ejunz' || requestFormat === 'simple') {
                    requestBody = { message };
                } else {
                    const messages = [...conversationHistory];
                    messages.push({ role: 'user', content: message });
                    requestBody = { model, messages, temperature: 0.7 };
                }

                const response = await request.send(requestBody);
                const result = response.body;

                // 尝试多种响应格式
                if (result.choices?.[0]?.message?.content) {
                    return result.choices[0].message.content;
                } else if (result.message) {
                    return result.message;
                } else if (result.text) {
                    return result.text;
                } else if (result.response) {
                    return result.response;
                } else if (typeof result === 'string') {
                    return result;
                } else {
                    return JSON.stringify(result);
                }
            } else {
                throw new Error(`不支持的AI provider: ${provider}`);
            }
           } catch (error: any) {
               this.logger.error('AI对话失败: %s', error.message);
            throw new Error(`AI对话失败: ${error.message}`);
        }
    }

    /**
     * AI对话（WebSocket流式版本 + 实时TTS）
     * 收到内容立即进行TTS，工具调用时暂停，完成后继续
     */
    async chatStreamWithTts(
        message: string, 
        conversationHistory: Array<{ role: string; content: string }> = [], 
        onAudioChunk?: (chunk: Buffer) => void,
        onTextChunk?: (chunk: string) => void,
        useCache?: boolean,  // 是否使用缓存模式（默认true）
        existingAudioId?: string  // 如果已有audioId，直接使用（用于提前发送URL的场景）
    ): Promise<string | { text: string; audioId?: string }> {
        const aiConfig = this.voiceConfig.ai || {};
        if (!aiConfig.provider) {
            throw new Error('AI未配置：请设置 voice.ai.provider');
        }

        const provider = aiConfig.provider.toLowerCase();
        const endpoint = aiConfig.endpoint || 'wss://beta.ejunz.com/api/agent/A4/stream';
        const requestFormat = aiConfig.requestFormat || 'simple';

        // 检查是否为WebSocket URL
        if (!endpoint.startsWith('ws://') && !endpoint.startsWith('wss://')) {
            // 如果不是WebSocket，回退到普通方式
            const text = await this.chatHTTP(message, conversationHistory);
            if (onTextChunk) {
                onTextChunk(text);
            }
            // 如果需要TTS，进行非流式TTS
            if (onAudioChunk) {
                const ttsConfig = this.voiceConfig.tts || {};
                const audioBuffer = await this.tts(text);
                onAudioChunk(audioBuffer);
            }
            return text;
        }

        let WS: any;
        try {
            WS = require('ws');
        } catch (e) {
            throw new Error('缺少 ws 依赖，请安装: npm install ws');
        }

        // 获取TTS配置
        const ttsConfig = this.voiceConfig.tts || {};
        // 注意：如果配置中没有明确指定model，对于流式TTS默认使用realtime版本
        // 但保留原有默认值以兼容现有配置
        const model = ttsConfig.model || 'qwen3-tts-flash-realtime';
        
        // 确定是否使用缓存模式（默认启用）
        // 注意：即使onAudioChunk是undefined，如果明确启用了缓存模式，也应该使用
        const useCacheMode = useCache !== false && (useCache === true || onAudioChunk !== undefined);
        let audioId: string | undefined;
        if (useCacheMode) {
            // 如果已有audioId（提前创建的场景），直接使用；否则创建新的
            audioId = existingAudioId || this.createAudioCache();
            if (existingAudioId) {
                this.logger.info(`[AI WebSocket+TTS] [缓存模式] 使用已有音频缓存: ${audioId}`);
            } else {
                this.logger.info(`[AI WebSocket+TTS] [缓存模式] 创建音频缓存: ${audioId}`);
            }
        }
        
        // useRealtimeTts：检查模型是否包含realtime，且（有onAudioChunk回调或使用缓存模式）
        // 如果模型包含realtime，应该启用流式TTS
        const useRealtimeTts = model.includes('realtime') && (onAudioChunk !== undefined || useCacheMode);
        
        // 记录TTS模式选择日志
        this.logger.info(`[AI WebSocket+TTS] TTS配置: model=${model}, useRealtimeTts=${useRealtimeTts}, useCacheMode=${useCacheMode}, onAudioChunk=${!!onAudioChunk}`);
        
        // 包装onAudioChunk：如果使用缓存模式，先写入缓存，但不立即调用onAudioChunk
        // 因为缓存模式下，音频将通过HTTP拉取方式播放，而不是实时WebSocket流
        const wrappedOnAudioChunk = useCacheMode ? (chunk: Buffer) => {
            if (audioId) {
                this.appendAudioToCache(audioId, chunk);
            }
            // 缓存模式下不立即调用onAudioChunk，避免重复播放
            // 音频将通过HTTP拉取后统一播放
        } : onAudioChunk;

        // 生成连接ID用于追踪
        const connectionId = `conn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 开始创建连接，消息: "%s"`, message.substring(0, 50));
        this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] 连接到: ${endpoint}`);

        return new Promise<string | { text: string; audioId?: string }>((resolve, reject) => {
            let fullResponse = '';
            let isResolved = false;
            let textBuffer = ''; // 文本缓冲区（用于累积）
            let ttsBuffer = ''; // TTS缓冲区（已append但未commit的文本）
            let isToolCalling = false; // 是否正在工具调用
            let ttsWs: any = null; // TTS WebSocket连接
            let ttsReady = false; // TTS连接是否就绪
            let ttsPendingText = ''; // TTS待发送文本队列
            let ttsClosed = false; // TTS连接是否已关闭
            let lastCommitTime = 0; // 上次commit时间
            let aiResponseDone = false; // AI响应是否已完成
            let pendingCommits = 0; // 待完成的commit数量（已commit但未收到response.audio.done）
            let finalizeTimer: NodeJS.Timeout | null = null; // 最终清理定时器
            let processedContents = new Set<string>(); // 已处理的内容片段（用于去重）
            let lastProcessedTime = Date.now(); // 上次处理内容的时间
            let contentMessageCount = 0; // 收到的content消息计数
            let sentenceCount = 0; // 已处理的句子计数（仅用于日志）
            let pendingSentences: string[] = []; // 待处理的句子队列（用于连接关闭时补全）
            // 按句子处理：累积到完整句子后再提交TTS
            const SENTENCE_END_REGEX = /[。！？\n\n]/; // 句子结束符：句号、问号、感叹号、双换行

            // 初始化TTS连接（复用单个连接）
            const initTtsConnection = () => {
                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] initTtsConnection被调用: useRealtimeTts=${useRealtimeTts}, wrappedOnAudioChunk=${!!wrappedOnAudioChunk}, useCacheMode=${useCacheMode}, ttsWs=${!!ttsWs}, ttsClosed=${ttsClosed}`);
                
                // 如果已经有连接或已关闭，不重复创建
                // 注意：缓存模式下wrappedOnAudioChunk不是undefined，而是写入缓存的函数
                if (!useRealtimeTts) {
                    this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] initTtsConnection跳过: useRealtimeTts=false`);
                    return;
                }
                if (!wrappedOnAudioChunk && !useCacheMode) {
                    this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] initTtsConnection跳过: wrappedOnAudioChunk未定义且非缓存模式`);
                    return;
                }
                if (ttsWs) {
                    this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] initTtsConnection跳过: TTS连接已存在，防止重复创建`);
                    return;
                }
                if (ttsClosed) {
                    this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] initTtsConnection跳过: TTS连接已关闭，不再创建`);
                    return;
                }

                let WS: any;
                try {
                    WS = require('ws');
                } catch (e) {
                    this.logger.error('[AI WebSocket+TTS] 缺少 ws 依赖');
                    return;
                }

                const apiKey = ttsConfig.apiKey;
                const model = ttsConfig.model || 'qwen3-tts-flash-realtime';
                const voice = ttsConfig.voice || 'Cherry';
                const languageType = ttsConfig.languageType || 'Chinese';
                
                const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
                const url = `${baseUrl}?model=${model}`;

                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 创建新的TTS连接 (之前连接状态: ttsWs=${!!ttsWs}, ttsClosed=${ttsClosed})`);
                
                ttsWs = new WS(url, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });

                ttsWs.on('open', () => {
                    this.logger.info(`[AI WebSocket+TTS] [${connectionId}] TTS连接已建立`);
                    ttsReady = false;
                    
                    // 发送session.update配置
                    const sessionUpdate = {
                        event_id: `event_${Date.now()}`,
                        type: 'session.update',
                        session: {
                            modalities: ['audio'],
                            output_audio_format: 'pcm16',
                            sample_rate: 24000,
                            output_audio_transcription: {
                                language: languageType === 'Chinese' ? 'zh' : 'en'
                            },
                            voice: voice
                        }
                    };
                    
                    ttsWs.send(JSON.stringify(sessionUpdate));
                });

                ttsWs.on('message', (data: Buffer | string) => {
                    try {
                        const textData = typeof data === 'string' ? data : data.toString('utf8');
                        const json = JSON.parse(textData);

                        if (json.type === 'session.created' || json.type === 'session.updated') {
                            if (!ttsReady) {
                                ttsReady = true;
                                // 只在第一次就绪时发送待处理的文本
                                if (ttsPendingText) {
                                    const pendingToSend = ttsPendingText;
                                    ttsPendingText = ''; // 先清空，避免重复
                                    appendTtsText(pendingToSend);
                                }
                            }
                        } else if (json.type === 'response.audio.delta') {
                            // 接收音频分片，立即发送给客户端
                            // 注意：缓存模式下，onAudioChunk是undefined，但wrappedOnAudioChunk仍会被调用以写入缓存
                            if (json.delta && !isToolCalling) {
                                const audioChunk = Buffer.from(json.delta, 'base64');
                                // 只在每10个chunk或重要事件时记录，减少日志噪音
                                if (useCacheMode) {
                                    // 缓存模式下更频繁地记录，便于调试
                                    this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] 收到音频分片: ${audioChunk.length} bytes`);
                                }
                                if (wrappedOnAudioChunk) {
                                    wrappedOnAudioChunk(audioChunk);
                                }
                            }
                        } else if (json.type === 'response.audio.done') {
                            // 音频生成完成，减少pending计数
                            if (pendingCommits > 0) {
                                pendingCommits--;
                            }
                            this.logger.info(`[AI WebSocket+TTS] [${connectionId}] TTS音频生成完成，剩余pending commits: %d`, pendingCommits);
                            
                            // 继续处理累积的文本（不等待pending commits）
                            if (textBuffer.length > 0 && !isToolCalling && !aiResponseDone) {
                                flushTextBuffer(false); // 不强制commit，让自动逻辑决定
                            }
                            
                            // 如果AI响应已完成，且所有文本都已commit，且所有音频都已生成完成，可以关闭连接
                            if (aiResponseDone && pendingCommits === 0 && ttsBuffer.length === 0 && textBuffer.length === 0) {
                                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 所有音频生成完成（pendingCommits=0），准备关闭TTS连接`);
                                // 等待一小段时间确保所有音频数据都已发送到客户端，然后关闭连接
                                finalizeTtsConnection(() => {
                                    // TTS连接关闭后resolve Promise
                                    if (!isResolved) {
                                        isResolved = true;
                                        // 如果使用缓存模式，标记缓存为就绪
                                        if (useCacheMode && audioId) {
                                            this.markCacheReady(audioId);
                                            resolve({ text: fullResponse, audioId });
                                        } else {
                                            resolve(fullResponse);
                                        }
                                    }
                                });
                            }
                        } else if (json.type === 'error') {
                            this.logger.error('[AI WebSocket+TTS] TTS错误: %s', JSON.stringify(json.error));
                            // 如果是因为buffer too small，说明commit太早，忽略这个错误继续处理
                            if (json.error?.code === 'invalid_value' && json.error?.message?.includes('buffer too small')) {
                                this.logger.debug('[AI WebSocket+TTS] TTS buffer太小错误，忽略并继续');
                            }
                        }
                    } catch (e: any) {
                        this.logger.error('[AI WebSocket+TTS] TTS消息处理失败: %s', e.message);
                    }
                });

                ttsWs.on('error', (err: Error) => {
                    this.logger.error('[AI WebSocket+TTS] TTS连接错误: %s', err.message);
                    ttsClosed = true; // 标记为已关闭，防止重复创建
                    ttsWs = null;
                    ttsReady = false;
                    // 如果连接错误，不再重连（避免重复连接）
                });

                ttsWs.on('close', (code: number, reason: Buffer) => {
                    this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] TTS连接关闭: ${code}, pendingCommits: ${pendingCommits}, reason: ${reason?.toString() || 'none'}`);
                    
                    // 总是标记为已关闭，防止重复创建连接
                    // 注意：即使连接关闭，后续句子仍可使用文件式TTS
                    ttsClosed = true;
                    ttsWs = null;
                    ttsReady = false;
                    
                    // 如果连接被关闭但还有pending的音频，需要处理
                    if (pendingCommits > 0) {
                        this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] TTS连接关闭时还有%d个pending commits，可能音频未完全生成，使用文件式TTS补全`, pendingCommits);
                        
                        // 获取最后pendingCommits个句子，使用文件式TTS补全
                        // 注意：pendingSentences可能不完整，我们只能从fullResponse中提取未处理的文本
                        const remainingText = textBuffer.trim();
                        if (remainingText.length > 0) {
                            this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 使用文件式TTS补全剩余文本: %d字符`, remainingText.length);
                            // 异步处理，不阻塞主流程
                            (async () => {
                                try {
                                    const audioBuffer = await this.tts(remainingText, ttsConfig.voice);
                                    if (audioBuffer && audioBuffer.length > 0) {
                                        const chunkSize = 4096;
                                        for (let i = 0; i < audioBuffer.length; i += chunkSize) {
                                            const chunk = audioBuffer.slice(i, i + chunkSize);
                                            onAudioChunk(chunk);
                                        }
                                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 文件式TTS补全完成，已发送%d字节`, audioBuffer.length);
                                    }
                                } catch (e: any) {
                                    this.logger.error(`[AI WebSocket+TTS] [${connectionId}] 文件式TTS补全失败: %s`, e.message);
                                }
                            })();
                        }
                        
                        // 减少pending计数（因为连接已关闭，无法继续生成）
                        pendingCommits = 0;
                        
                        // 如果AI响应已完成，等待文件式TTS完成后再resolve
                        // 注意：这里不立即resolve，等待finalizeTtsConnection来处理
                        // if (aiResponseDone && !isResolved) {
                        //     // 等待文件式TTS完成（如果有剩余文本）
                        //     const waitTime = remainingText.length > 0 ? 3000 : 500;
                        //     this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 等待%dms后resolve（文件式TTS补全）`, waitTime);
                        //     setTimeout(() => {
                        //         if (!isResolved) {
                        //             isResolved = true;
                        //             // 如果使用缓存模式，标记缓存为就绪
                        //             if (useCacheMode && audioId) {
                        //                 this.markCacheReady(audioId);
                        //                 resolve({ text: fullResponse, audioId });
                        //             } else {
                        //                 resolve(fullResponse);
                        //             }
                        //         }
                        //     }, waitTime);
                        // }
                    } else {
                        // 没有pending commits，但不立即resolve，等待finalizeTtsConnection
                        // 确保所有音频都写入缓存后再标记为ready
                        // if (aiResponseDone && !isResolved) {
                        //     setTimeout(() => {
                        //         if (!isResolved) {
                        //             isResolved = true;
                        //             // 如果使用缓存模式，标记缓存为就绪
                        //             if (useCacheMode && audioId) {
                        //                 this.markCacheReady(audioId);
                        //                 resolve({ text: fullResponse, audioId });
                        //             } else {
                        //                 resolve(fullResponse);
                        //             }
                        //         }
                        //     }, 500);
                        // }
                    }
                    
                    if (code === 1007 && reason?.toString().includes('rate limit')) {
                        // 限流错误，记录日志
                        this.logger.warn('[AI WebSocket+TTS] TTS连接因限流关闭');
                    } else if (code === 1005 || code === 1006) {
                        // 服务器主动关闭或异常关闭（可能是超时或连接问题）
                        this.logger.warn('[AI WebSocket+TTS] TTS服务器主动关闭连接，可能是超时或连接问题');
                    }
                });
            };

            // Append文本到TTS缓冲区（不立即commit）
            const appendTtsText = (textToAppend: string) => {
                if (!textToAppend || textToAppend.trim().length === 0) {
                    return;
                }

                if (!ttsWs) {
                    // 连接不存在，缓存到pending
                    ttsPendingText += textToAppend;
                    return;
                }

                if (!ttsReady) {
                    // 连接未就绪，缓存文本
                    ttsPendingText += textToAppend;
                    return;
                }

                if (isToolCalling) {
                    // 工具调用中，不append
                    return;
                }

                // 发送append事件
                const appendEvent = {
                    event_id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                    type: 'input_text_buffer.append',
                    text: textToAppend
                };
                
                try {
                    ttsWs.send(JSON.stringify(appendEvent));
                    ttsBuffer += textToAppend; // 记录已append的文本
                    this.logger.debug('[AI WebSocket+TTS] Append文本到TTS: %d字符, 总缓冲区: %d字符', textToAppend.length, ttsBuffer.length);
                } catch (e: any) {
                    this.logger.error('[AI WebSocket+TTS] Append失败: %s', e.message);
                }
            };

            // Commit TTS缓冲区（触发合成）
            const commitTtsBuffer = (force = false) => {
                // force模式下，即使isToolCalling也允许提交（用于done消息时的强制提交）
                if (!ttsWs || !ttsReady || (!force && isToolCalling)) {
                    this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] Commit跳过: ttsWs=%s, ttsReady=%s, isToolCalling=%s, force=%s`, !!ttsWs, ttsReady, isToolCalling, force);
                    return;
                }

                // force模式下总是commit，非force模式下如果缓冲区为空则不commit
                // 注意：按句子处理时，force应该总是true

                // 如果缓冲区为空，不commit
                if (ttsBuffer.trim().length === 0) {
                    this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] Commit跳过: 缓冲区为空`);
                    return;
                }

                const bufferLength = ttsBuffer.length; // 保存长度用于日志
                const bufferContent = ttsBuffer.substring(0, 50); // 保存前50字符用于日志
                const commitEvent = {
                    event_id: `event_${Date.now()}`,
                    type: 'input_text_buffer.commit'
                };
                
                try {
                    ttsWs.send(JSON.stringify(commitEvent));
                    pendingCommits++; // 增加pending计数
                    this.logger.info('[AI WebSocket+TTS] TTS commit，触发合成 (缓冲区: %d字符, 内容: "%s...", pending: %d)', bufferLength, bufferContent, pendingCommits);
                    ttsBuffer = ''; // 清空缓冲区
                    lastCommitTime = Date.now();
                } catch (e: any) {
                    this.logger.error('[AI WebSocket+TTS] Commit发送失败: %s', e.message);
                }
            };
            
            // 最终化TTS连接（等待所有音频生成完成后关闭）
            const finalizeTtsConnection = (onClose?: () => void) => {
                if (ttsClosed || !ttsWs) {
                    if (onClose) onClose();
                    return;
                }
                
                // 清除之前的定时器
                if (finalizeTimer) {
                    clearTimeout(finalizeTimer);
                    finalizeTimer = null;
                }
                
                // 等待所有pending commits完成后再关闭连接
                // 优化：减少等待时间，但确保所有音频都生成并写入缓存
                // 计算等待时间：基础1秒 + 每个pending commit 1.5秒，最大30秒
                const baseWaitTime = 1000; // 基础等待时间1秒
                const waitTime = pendingCommits > 0 
                    ? Math.min(baseWaitTime + pendingCommits * 1500, 30000) 
                    : baseWaitTime;
                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 准备关闭TTS连接，等待%dms确保所有音频完成 (pendingCommits: %d, ttsBuffer: %d, textBuffer: %d)`, waitTime, pendingCommits, ttsBuffer.length, textBuffer.length);
                
                // 等待确保所有音频都发送完成，然后关闭
                finalizeTimer = setTimeout(() => {
                    if (ttsWs && !ttsClosed) {
                        this.logger.info('[AI WebSocket+TTS] 关闭TTS连接 (最终等待时间: %dms, pendingCommits: %d)', waitTime, pendingCommits);
                        try {
                            const finishEvent = {
                                event_id: `event_${Date.now()}`,
                                type: 'session.finish'
                            };
                            ttsWs.send(JSON.stringify(finishEvent));
                            setTimeout(() => {
                                if (ttsWs) {
                                    ttsWs.close();
                                    ttsWs = null;
                                    ttsClosed = true;
                                    // 等待一小段时间确保所有音频数据都已写入缓存，再调用onClose
                                    setTimeout(() => {
                                        if (onClose) onClose();
                                    }, 200); // 减少等待时间到200ms
                                } else {
                                    if (onClose) onClose();
                                }
                            }, 500); // 增加等待时间到500ms
                        } catch (e: any) {
                            this.logger.error('[AI WebSocket+TTS] 关闭TTS连接失败: %s', e.message);
                            ttsClosed = true;
                            if (onClose) onClose();
                        }
                    } else {
                        if (onClose) onClose();
                    }
                }, waitTime);
            };

            // 处理完整句子：纯流式TTS，保持连接直到所有音频生成完成
            const flushSentence = async (sentence: string) => {
                if (!sentence || sentence.trim().length === 0) {
                    return;
                }

                // 注意：useRealtimeTts已经包含了缓存模式的检查
                if (!useRealtimeTts) {
                    return;
                }

                sentenceCount++;

                try {
                    // 确保TTS连接已初始化
                    if (!ttsWs && !ttsClosed) {
                        initTtsConnection();
                        // 如果连接还未就绪，先缓存文本
                        if (!ttsReady) {
                            ttsPendingText += sentence;
                            this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] TTS未就绪，缓存句子: %d字符`, sentence.length);
                            return;
                        }
                    }

                    // 如果连接存在且就绪，使用流式TTS
                    if (ttsWs && ttsReady && !ttsClosed) {
                        // Append完整句子到TTS缓冲区
                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 流式处理句子 #%d (%d字符): "%s"`, sentenceCount, sentence.length, sentence.substring(0, 50));
                        appendTtsText(sentence);

                        // 立即commit（因为是完整句子）
                        commitTtsBuffer(true);
                    } else if (ttsClosed) {
                        // 连接已关闭，记录警告但不尝试重连（由finalize处理）
                        this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] TTS连接已关闭，无法处理句子 #%d`, sentenceCount);
                    }
                } catch (e: any) {
                    this.logger.error(`[AI WebSocket+TTS] [${connectionId}] 流式TTS处理句子失败: %s`, e.message);
                    // 流式失败时标记连接为关闭，但不尝试文件式（保持纯流式）
                    if (!ttsClosed) {
                        ttsClosed = true;
                    }
                }
            };

            // 处理文本缓冲区（用于done消息时的强制flush）
            const flushTextBuffer = (shouldCommit = false) => {
                if (textBuffer.length === 0) {
                    return;
                }

                // shouldCommit=true时（done消息），即使isToolCalling也允许flush（因为done时isToolCalling已被设为false）
                if (isToolCalling && !shouldCommit) {
                    this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] Flush跳过: 工具调用中 (shouldCommit=%s)`, shouldCommit);
                    return;
                }

                const textToTts = textBuffer;
                textBuffer = ''; // 清空缓冲区

                // 注意：useRealtimeTts已经包含了缓存模式的检查
                if (!useRealtimeTts) {
                    return;
                }

                // 确保TTS连接已初始化
                if (!ttsWs && !ttsClosed) {
                    initTtsConnection();
                    // 如果连接还未就绪，先缓存文本
                    if (!ttsReady) {
                        ttsPendingText += textToTts;
                        this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] TTS未就绪，缓存文本: %d字符`, textToTts.length);
                        return;
                    }
                }

                // Append文本到TTS缓冲区并立即commit（done消息时强制提交剩余内容）
                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] Flush剩余文本到TTS: %d字符`, textToTts.length);
                appendTtsText(textToTts);
                if (shouldCommit && textToTts.trim().length > 0) {
                    commitTtsBuffer(true); // 强制commit
                }
            };

            // 添加文本到缓冲区并触发TTS
            const addText = async (content: string) => {
                // 防止重复处理：检查是否在短时间内收到完全相同的内容
                const now = Date.now();
                const timeSinceLastProcess = now - lastProcessedTime;
                
                // 如果内容完全相同且在1秒内重复收到，可能是重复消息
                if (processedContents.has(content) && timeSinceLastProcess < 1000) {
                    this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] 检测到重复内容（1秒内），跳过: "%s"`, content.substring(0, 50));
                    return;
                }
                
                // 记录已处理的内容（只保留最近10个，避免内存泄漏）
                processedContents.add(content);
                if (processedContents.size > 10) {
                    const first = processedContents.values().next().value;
                    processedContents.delete(first);
                }
                lastProcessedTime = now;
                
                this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] 收到文本片段: "%s" (textBuffer长度: %d)`, content.substring(0, 50), textBuffer.length);
                
                // 累积到fullResponse（用于最终返回）
                fullResponse += content;

                // 注意：缓存模式下onAudioChunk是undefined，但useRealtimeTts是true，应该继续处理
                if (!useRealtimeTts) {
                    // 如果不使用TTS，立即发送文本片段
                    if (onTextChunk) {
                        onTextChunk(content);
                    }
                    return;
                }

                // 累积文本到缓冲区（按句子累积，不立即发送）
                textBuffer += content;

                // 检查是否遇到句子结束符（句号、问号、感叹号、双换行、英文句号等）
                // 匹配从开头到第一个句子结束符的完整句子
                let sentenceEndIndex = -1;
                let endLength = 1; // 结束符长度
                
                // 先检查双换行（优先）
                const doubleNewlineIndex = textBuffer.search(/\n\n/);
                if (doubleNewlineIndex >= 0) {
                    sentenceEndIndex = doubleNewlineIndex;
                    endLength = 2; // 双换行是2个字符
                } else {
                    // 检查中文句号、问号、感叹号
                    const chineseEndIndex = textBuffer.search(/[。！？]/);
                    if (chineseEndIndex >= 0) {
                        sentenceEndIndex = chineseEndIndex;
                        endLength = 1;
                    } else {
                        // 检查英文句号（需要确保后面有空格或换行，避免误判小数点等）
                        const englishPeriodIndex = textBuffer.search(/\.(\s|\n|$)/);
                        if (englishPeriodIndex >= 0) {
                            sentenceEndIndex = englishPeriodIndex;
                            endLength = 1; // 只包含句号，空格在下一句
                        }
                    }
                }
                
                // 如果找到完整句子，处理它
                if (sentenceEndIndex >= 0 && !isToolCalling) {
                    // 提取完整句子（包含结束符）
                    const sentence = textBuffer.substring(0, sentenceEndIndex + endLength).trim();
                    const remaining = textBuffer.substring(sentenceEndIndex + endLength).trim();
                    
                    if (sentence.length > 0) {
                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 检测到完整句子 (%d字符): "%s"`, sentence.length, sentence.substring(0, 50));
                        
                        // 处理完整句子
                        textBuffer = remaining; // 保留剩余文本
                        
                        // 按句子发送文本（而不是逐字符）
                        if (onTextChunk) {
                            onTextChunk(sentence + ' '); // 加上空格分隔句子
                        }
                        
                        // 提交整句给TTS
                        await flushSentence(sentence);
                    } else {
                        // 句子为空（可能是只有标点），清空这部分
                        textBuffer = remaining;
                    }
                } else if (textBuffer.length > 80 && !isToolCalling) {
                    // 优化：降低阈值到80字符，提高响应速度
                    // 如果缓冲区过长但还没有句子结束符，尝试在逗号、分号处分割
                    const commaIndex = textBuffer.lastIndexOf('，');
                    const semicolonIndex = textBuffer.lastIndexOf('；');
                    const commaEnIndex = textBuffer.lastIndexOf(',');
                    const splitIndex = Math.max(commaIndex, semicolonIndex, commaEnIndex);
                    
                    if (splitIndex > 30) {
                        // 在逗号/分号处分割
                        const forceSentence = textBuffer.substring(0, splitIndex + 1).trim();
                        textBuffer = textBuffer.substring(splitIndex + 1).trim();
                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 缓冲区达到%d字符，在逗号处分割提交: "%s..."`, textBuffer.length + forceSentence.length, forceSentence.substring(0, 50));
                        
                        // 按句子发送文本
                        if (onTextChunk) {
                            onTextChunk(forceSentence + ' ');
                        }
                        await flushSentence(forceSentence);
                    } else {
                        // 没有合适的分割点，强制提交前80字符（降低阈值）
                        const forceSentence = textBuffer.substring(0, 80).trim();
                        textBuffer = textBuffer.substring(80).trim();
                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 缓冲区达到%d字符，强制提交: "%s..."`, textBuffer.length + forceSentence.length, forceSentence.substring(0, 50));
                        
                        // 按句子发送文本
                        if (onTextChunk) {
                            onTextChunk(forceSentence + ' ');
                        }
                        await flushSentence(forceSentence);
                    }
                }
            };

            const ws = new WS(endpoint, {
                // 不需要认证，直接连接
            });

            ws.on('open', () => {
                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] AI连接已建立，准备发送请求`);

                // 初始化TTS连接（在AI连接建立后）
                // 注意：useRealtimeTts已经包含了缓存模式的检查
                if (useRealtimeTts) {
                    this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] 准备初始化TTS连接 (useCacheMode=${useCacheMode}, onAudioChunk=${!!onAudioChunk})`);
                    initTtsConnection();
                }

                // 构建请求消息
                let requestMessage: any;
                if (provider === 'ejunz' || requestFormat === 'simple') {
                    requestMessage = { message };
                } else {
                    const messages = [...conversationHistory];
                    messages.push({ role: 'user', content: message });
                    requestMessage = { messages };
                }

                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 发送AI请求: %s`, JSON.stringify(requestMessage).substring(0, 100));
                ws.send(JSON.stringify(requestMessage));
            });

            ws.on('message', async (data: Buffer | string) => {
                try {
                    const textData = typeof data === 'string' ? data : data.toString('utf8');
                    const trimmedText = textData.trim();
                    
                    // 过滤掉系统消息（如ping）
                    if (trimmedText === 'ping' || trimmedText === 'pong' || trimmedText.toLowerCase() === 'ping' || trimmedText.toLowerCase() === 'pong') {
                        this.logger.debug('[AI WebSocket+TTS] 忽略系统消息: %s', trimmedText);
                        return;
                    }

                    this.logger.debug('[AI WebSocket+TTS] 收到消息: %s', textData.substring(0, 200));

                    // 尝试解析JSON
                    let json: any;
                    try {
                        json = JSON.parse(textData);
                    } catch {
                        // 如果不是JSON，且不是系统消息，忽略（AI应该返回JSON格式）
                        this.logger.debug('[AI WebSocket+TTS] 忽略非JSON消息（非content类型）');
                        return;
                    }

                    // 只处理AI实际回复的内容，忽略其他类型的消息
                    if (json.type === 'text' || json.type === 'content') {
                        // 文本内容，立即处理（只处理content类型的消息）
                        const content = json.content || json.text || '';
                        if (content && content.trim()) {
                            // 确保不是系统消息
                            const contentTrimmed = content.trim().toLowerCase();
                            const systemMessages = ['ping', 'pong', 'connected', 'websocket connected', 'websocket stream connection established'];
                            if (!systemMessages.some(msg => contentTrimmed.includes(msg))) {
                                contentMessageCount++;
                                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 收到第%d个content消息: "%s"`, contentMessageCount, content.substring(0, 50));
                                await addText(content);
                            } else {
                                this.logger.debug(`[AI WebSocket+TTS] [${connectionId}] 忽略content中的系统消息: %s`, content);
                            }
                        }
                    } else if (json.type === 'connected' || json.type === 'connection') {
                        // 忽略连接确认消息
                        this.logger.debug('[AI WebSocket+TTS] 忽略连接消息: %s', json.type);
                    } else if (json.type === 'tool_call_start') {
                        // 工具调用开始，暂停TTS（不添加提示，避免额外commit）
                        this.logger.info('[AI WebSocket+TTS] 工具调用开始，暂停TTS');
                        
                        // 先flush当前缓冲区并等待完成
                        if (textBuffer.length > 0) {
                            flushTextBuffer(true); // 强制commit
                        }
                        // 如果ttsBuffer有内容，也需要commit
                        if (ttsBuffer.length > 0) {
                            commitTtsBuffer(true); // 强制commit
                        }
                        
                        isToolCalling = true;
                    } else if (json.type === 'tool_call' || json.tool_calls || json.toolCall) {
                        // 工具调用请求（直接格式）
                        isToolCalling = true;
                        
                        // 先flush当前缓冲区并commit
                        if (textBuffer.length > 0) {
                            flushTextBuffer(true); // 强制commit
                        }
                        // 如果ttsBuffer有内容，也需要commit
                        if (ttsBuffer.length > 0) {
                            commitTtsBuffer(true); // 强制commit
                        }

                        const toolCalls = json.tool_calls || (json.toolCall ? [json.toolCall] : []);
                        for (const toolCall of toolCalls) {
                            await this.handleToolCall(toolCall, ws);
                        }
                    } else if (json.type === 'tool_result' || json.type === 'tool_call_complete') {
                        // 工具调用完成，恢复TTS
                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 工具调用完成，恢复TTS`);
                        isToolCalling = false;
                        // 工具调用完成后，继续处理后续内容
                        // 检查是否有待处理的完整句子
                        if (textBuffer.length > 0) {
                            let sentenceEndIndex = -1;
                            let endLength = 1;
                            const doubleNewlineIndex = textBuffer.search(/\n\n/);
                            if (doubleNewlineIndex >= 0) {
                                sentenceEndIndex = doubleNewlineIndex;
                                endLength = 2;
                            } else {
                                const singleEndIndex = textBuffer.search(/[。！？]/);
                                if (singleEndIndex >= 0) {
                                    sentenceEndIndex = singleEndIndex;
                                    endLength = 1;
                                }
                            }
                            if (sentenceEndIndex >= 0) {
                                const sentence = textBuffer.substring(0, sentenceEndIndex + endLength);
                                textBuffer = textBuffer.substring(sentenceEndIndex + endLength);
                                await flushSentence(sentence.trim());
                            }
                        }
                    } else if (json.type === 'done' || json.type === 'finished') {
                        // AI响应完成，但TTS可能还在生成音频
                        // 注意：done消息中的message字段是完整的回复，但我们已经在流式content中处理了所有片段
                        // 所以不需要处理json.message，只标记完成即可
                        this.logger.info(`[AI WebSocket+TTS] [${connectionId}] AI响应完成，等待TTS音频生成完成 (content消息数: %d, fullResponse长度: %d, done.message长度: %d)`, contentMessageCount, fullResponse.length, json.message?.length || 0);
                        
                        // 验证fullResponse和done.message是否一致（用于调试）
                        if (json.message && Math.abs(fullResponse.length - json.message.length) > 10) {
                            this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] 警告：fullResponse长度(%d)与done.message长度(%d)差异较大，可能存在内容丢失或重复`, fullResponse.length, json.message.length);
                        }
                        aiResponseDone = true;
                        
                        // flush剩余缓冲区并commit
                        isToolCalling = false;
                        if (textBuffer.length > 0) {
                            this.logger.info(`[AI WebSocket+TTS] [${connectionId}] done消息到达，处理剩余textBuffer: %d字符`, textBuffer.length);
                            // 尝试提取完整句子
                            let remaining = textBuffer;
                            while (remaining.length > 0) {
                                let sentenceEndIndex = -1;
                                let endLength = 1;
                                const doubleNewlineIndex = remaining.search(/\n\n/);
                                if (doubleNewlineIndex >= 0) {
                                    sentenceEndIndex = doubleNewlineIndex;
                                    endLength = 2;
                                } else {
                                    const chineseEndIndex = remaining.search(/[。！？]/);
                                    if (chineseEndIndex >= 0) {
                                        sentenceEndIndex = chineseEndIndex;
                                        endLength = 1;
                                    } else {
                                        const englishPeriodIndex = remaining.search(/\.(\s|\n|$)/);
                                        if (englishPeriodIndex >= 0) {
                                            sentenceEndIndex = englishPeriodIndex;
                                            endLength = 1;
                                        }
                                    }
                                }
                                if (sentenceEndIndex >= 0) {
                                    const sentence = remaining.substring(0, sentenceEndIndex + endLength).trim();
                                    remaining = remaining.substring(sentenceEndIndex + endLength).trim();
                                    
                                    if (sentence.length > 0) {
                                        // 按句子发送文本
                                        if (onTextChunk) {
                                            onTextChunk(sentence + ' ');
                                        }
                                        await flushSentence(sentence);
                                    }
                                } else {
                                    // 没有完整句子，直接提交剩余内容
                                    const finalSentence = remaining.trim();
                                    if (finalSentence.length > 0) {
                                        // 按句子发送文本
                                        if (onTextChunk) {
                                            onTextChunk(finalSentence + ' ');
                                        }
                                        await flushSentence(finalSentence);
                                    }
                                    break;
                                }
                            }
                            textBuffer = ''; // 清空缓冲区
                        }
                        // 确保所有文本都已commit（强制commit，即使很小）
                        if (ttsBuffer.length > 0 && ttsWs && ttsReady) {
                            this.logger.info(`[AI WebSocket+TTS] [${connectionId}] done消息到达，commit剩余ttsBuffer: %d字符`, ttsBuffer.length);
                            commitTtsBuffer(true); // 强制commit剩余文本
                        }
                        
                        // 注意：不要立即关闭AI WebSocket连接
                        // 保持连接打开，直到所有TTS音频都生成完成后再关闭
                        // ws.close(); // 注释掉，让finalizeTtsConnection来关闭
                        
                        // 延迟调用finalizeTtsConnection，确保所有文本都已真正提交（pendingCommits已更新）
                        // 等待一小段时间确保所有commit操作都已完成
                        setTimeout(() => {
                            const finalPendingCommits = pendingCommits;
                            const finalTtsBuffer = ttsBuffer.length;
                            const finalTextBuffer = textBuffer.length;
                            
                            this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 延迟后开始等待TTS音频完成 (pending: %d, ttsBuffer: %d, textBuffer: %d)`, finalPendingCommits, finalTtsBuffer, finalTextBuffer);
                            
                            // 如果还有文本在缓冲区但没有提交，强制提交
                            if (finalTextBuffer > 0 && ttsWs && ttsReady) {
                                this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] 延迟后仍有textBuffer未处理，强制flush并commit`);
                                flushTextBuffer(true);
                            }
                            if (finalTtsBuffer > 0 && ttsWs && ttsReady) {
                                this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] 延迟后仍有ttsBuffer未提交，强制commit`);
                                commitTtsBuffer(true);
                            }
                            
                            // 再次等待一小段时间确保新的commit已生效
                            setTimeout(() => {
                                const actualPendingCommits = pendingCommits;
                                this.logger.info(`[AI WebSocket+TTS] [${connectionId}] 实际pendingCommits: %d，开始finalize`, actualPendingCommits);
                                
                                finalizeTtsConnection(() => {
                                    // TTS连接关闭后resolve Promise
                                    if (!isResolved) {
                                        isResolved = true;
                                        // 如果使用缓存模式，标记缓存为就绪
                                        if (useCacheMode && audioId) {
                                            this.markCacheReady(audioId);
                                            resolve({ text: fullResponse, audioId });
                                        } else {
                                            resolve(fullResponse);
                                        }
                                    }
                                });
                                
                                // 设置一个超时保护，最多等待30秒（给足够时间让所有音频生成和传输）
                                setTimeout(() => {
                                    if (!isResolved) {
                                        this.logger.warn(`[AI WebSocket+TTS] [${connectionId}] 等待超时（30秒），强制关闭并resolve (pendingCommits: %d)`, pendingCommits);
                                        finalizeTtsConnection(() => {
                                            if (!isResolved) {
                                                isResolved = true;
                                                // 如果使用缓存模式，标记缓存为就绪
                                                if (useCacheMode && audioId) {
                                                    this.markCacheReady(audioId);
                                                    resolve({ text: fullResponse, audioId });
                                                } else {
                                                    resolve(fullResponse);
                                                }
                                            }
                                        });
                                    }
                                }, 30000);
                            }, 200); // 再等待200ms确保commit生效
                        }, 300); // 等待300ms确保所有flush和commit操作完成
                    } else if (json.type && json.type !== 'ping' && json.type !== 'pong' && json.type !== 'text' && json.type !== 'content') {
                        // 其他类型的消息（tool_result, tool_call等），不发送到TTS
                        // 只记录日志，不处理内容
                        this.logger.debug('[AI WebSocket+TTS] 忽略非content类型消息: %s', json.type);
                    } else if (json.error) {
                        // 错误
                        this.logger.error('[AI WebSocket+TTS] 错误: %s', JSON.stringify(json.error));
                        isToolCalling = false;
                        if (ttsWs) {
                            ttsWs.close();
                            ttsWs = null;
                        }
                        ws.close();
                        if (!isResolved) {
                            isResolved = true;
                            reject(new Error(`AI错误: ${json.error.message || JSON.stringify(json.error)}`));
                        }
                    }
                } catch (e: any) {
                    this.logger.error('[AI WebSocket+TTS] 处理消息失败: %s', e.message);
                }
            });

            ws.on('error', (err: Error) => {
                this.logger.error('[AI WebSocket+TTS] AI连接错误: %s', err.message);
                isToolCalling = false;
                if (ttsWs) {
                    ttsWs.close();
                    ttsWs = null;
                }
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            });

            ws.on('close', (code: number, reason: Buffer) => {
                this.logger.debug(`[AI WebSocket+TTS] AI连接关闭: ${code} - ${reason?.toString() || ''}`);
                isToolCalling = false;
                // flush并commit剩余文本
                if (textBuffer.length > 0) {
                    flushTextBuffer(true);
                }
                if (ttsBuffer.length > 0 && ttsWs && ttsReady) {
                    commitTtsBuffer(true); // 强制commit剩余文本
                }
                // 关闭TTS连接
                if (ttsWs) {
                    setTimeout(() => {
                        if (ttsWs) {
                            const finishEvent = {
                                event_id: `event_${Date.now()}`,
                                type: 'session.finish'
                            };
                            ttsWs.send(JSON.stringify(finishEvent));
                            setTimeout(() => {
                                if (ttsWs) {
                                    ttsWs.close();
                                }
                            }, 100);
                        }
                    }, 500);
                }
                // 注意：不要在AI连接关闭时立即resolve和标记缓存为ready
                // 因为TTS可能还在生成音频，应该等TTS连接关闭后再处理
                // 这里不resolve，让finalizeTtsConnection来处理
                // if (!isResolved) {
                //     isResolved = true;
                //     // 如果使用缓存模式，标记缓存为就绪
                //     if (useCacheMode && audioId) {
                //         this.markCacheReady(audioId);
                //         resolve({ text: fullResponse, audioId });
                //     } else {
                //         resolve(fullResponse);
                //     }
                // }
            });

            // 设置超时
            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    isToolCalling = false;
                    // flush并commit剩余文本
                    if (textBuffer.length > 0) {
                        flushTextBuffer(true);
                    }
                    if (ttsBuffer.length > 0 && ttsWs && ttsReady) {
                        commitTtsBuffer();
                    }
                    if (ttsWs) {
                        setTimeout(() => {
                            if (ttsWs) {
                                ttsWs.close();
                            }
                        }, 500);
                    }
                    ws.close();
                    if (fullResponse) {
                        // 如果使用缓存模式，标记缓存为就绪
                        if (useCacheMode && audioId) {
                            this.markCacheReady(audioId);
                            resolve({ text: fullResponse, audioId });
                        } else {
                            resolve(fullResponse);
                        }
                    } else {
                        reject(new Error('AI响应超时'));
                    }
                }
            }, 60000); // 60秒超时
        });
    }

    /**
     * AI对话（兼容旧接口，默认使用流式版本）
     */
    async chat(message: string, conversationHistory: Array<{ role: string; content: string }> = []): Promise<string> {
        // 默认使用流式版本，但不回调onChunk
        return await this.chatStream(message, conversationHistory);
    }


    /**
     * Qwen TTS Realtime WebSocket实现（流式版本）
     * 根据文档：https://help.aliyun.com/zh/model-studio/interactive-process-of-qwen-tts-realtime-synthesis
     * @param onAudioChunk 收到音频分片时的回调函数
     */
    private async qwenTtsRealtimeStream(text: string, ttsConfig: any, onAudioChunk: (chunk: Buffer) => void): Promise<void> {
        let WS: any;
        try {
            WS = require('ws');
        } catch (e) {
            throw new Error('缺少 ws 依赖，请安装: npm install ws');
        }

        const apiKey = ttsConfig.apiKey;
        const model = ttsConfig.model || 'qwen3-tts-flash-realtime';
        const voice = ttsConfig.voice || 'Cherry';
        const languageType = ttsConfig.languageType || 'Chinese';
        
        // Qwen TTS Realtime WebSocket地址
        const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
        const url = `${baseUrl}?model=${model}`;

        this.logger.debug(`[TTS Realtime Stream] 连接到: ${url.replace(apiKey, '***')}`);

        const logger = this.logger; // 保存logger引用以便在闭包中使用
        
        return new Promise((resolve, reject) => {
            let sessionId: string | null = null;
            let isTextSent = false;

            const ws = new WS(url, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'OpenAI-Beta': 'realtime=v1'
                }
            });

            ws.on('open', () => {
                logger.debug('[TTS Realtime Stream] 连接已建立');
                
                // 发送session.update配置
                const sessionUpdate = {
                    event_id: `event_${Date.now()}`,
                    type: 'session.update',
                    session: {
                        modalities: ['audio'],
                        output_audio_format: 'pcm16',
                        sample_rate: 24000,
                        output_audio_transcription: {
                            language: languageType === 'Chinese' ? 'zh' : 'en'
                        },
                        voice: voice
                    }
                };
                
                ws.send(JSON.stringify(sessionUpdate));
                logger.debug('[TTS Realtime Stream] 发送session.update');
            });

            ws.on('message', (data: Buffer | string) => {
                try {
                    const textData = typeof data === 'string' ? data : data.toString('utf8');
                    const json = JSON.parse(textData);
                    
                    // 移除所有频繁的日志输出，减少噪音
                    // logger.debug('[TTS Realtime Stream] 收到消息: %s', json.type);

                    if (json.type === 'session.created') {
                        sessionId = json.session?.id || null;
                        // 会话创建日志改为debug，减少噪音
                        // logger.debug('[TTS Realtime Stream] 会话已创建: %s', sessionId);
                    } else if (json.type === 'session.updated') {
                        // logger.debug('[TTS Realtime Stream] 会话已更新');
                        // 开始发送文本
                        if (!isTextSent) {
                            isTextSent = true;
                            sendText();
                        }
                    } else if (json.type === 'response.created') {
                        // logger.debug('[TTS Realtime Stream] 响应已创建，开始接收音频');
                    } else if (json.type === 'response.audio.delta') {
                        // 接收音频分片，立即发送给客户端
                        if (json.delta) {
                            const audioChunk = Buffer.from(json.delta, 'base64');
                            // 完全移除频繁的音频分片日志
                            // logger.debug('[TTS Realtime Stream] 收到音频分片: %d bytes，立即推送', audioChunk.length);
                            // 立即调用回调函数发送给客户端
                            onAudioChunk(audioChunk);
                        }
                    } else if (json.type === 'response.audio.done') {
                        // 音频生成完成
                        logger.debug('[TTS Realtime Stream] 音频生成完成');
                        
                        // 发送session.finish并关闭连接
                        const finishEvent = {
                            event_id: `event_${Date.now()}`,
                            type: 'session.finish'
                        };
                        ws.send(JSON.stringify(finishEvent));
                        
                        setTimeout(() => {
                            ws.close();
                            resolve();
                        }, 100);
                    } else if (json.type === 'error') {
                        logger.error('[TTS Realtime Stream] 错误: %s', JSON.stringify(json));
                        ws.close();
                        reject(new Error(`TTS错误: ${json.error?.message || JSON.stringify(json)}`));
                    }
                } catch (e: any) {
                    logger.error('[TTS Realtime Stream] 处理消息失败: %s', e.message);
                }
            });

            ws.on('error', (err: Error) => {
                logger.error('[TTS Realtime Stream] 连接错误: %s', err.message);
                reject(err);
            });

            ws.on('close', (code: number, reason: Buffer) => {
                logger.debug(`[TTS Realtime Stream] 连接关闭: ${code} - ${reason?.toString() || ''}`);
            });

            // 发送文本到缓冲区
            function sendText() {
                const chunkSize = 100; // 每次发送100个字符
                let offset = 0;
                
                function sendChunk() {
                    if (offset >= text.length) {
                        // 所有文本已发送，发送commit触发合成
                        const commitEvent = {
                            event_id: `event_${Date.now()}`,
                            type: 'input_text_buffer.commit'
                        };
                        ws.send(JSON.stringify(commitEvent));
                        logger.debug('[TTS Realtime Stream] 文本发送完成，发送commit');
                        return;
                    }

                    const chunk = text.substring(offset, offset + chunkSize);
                    const appendEvent = {
                        event_id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                        type: 'input_text_buffer.append',
                        text: chunk
                    };
                    
                    ws.send(JSON.stringify(appendEvent));
                    logger.debug('[TTS Realtime Stream] 发送文本块: %s', chunk.substring(0, 50));
                    
                    offset += chunkSize;
                    
                    // 继续发送下一块
                    setTimeout(sendChunk, 10);
                }
                
                sendChunk();
            }
        });
    }

    /**
     * Qwen TTS Realtime WebSocket实现（非流式版本，兼容旧接口）
     * 根据文档：https://help.aliyun.com/zh/model-studio/interactive-process-of-qwen-tts-realtime-synthesis
     */
    private async qwenTtsRealtime(text: string, ttsConfig: any): Promise<Buffer> {
        let WS: any;
        try {
            WS = require('ws');
        } catch (e) {
            throw new Error('缺少 ws 依赖，请安装: npm install ws');
        }

        const apiKey = ttsConfig.apiKey;
        const model = ttsConfig.model || 'qwen3-tts-flash-realtime';
        const voice = ttsConfig.voice || 'Cherry';
        const languageType = ttsConfig.languageType || 'Chinese';
        
        // Qwen TTS Realtime WebSocket地址
        const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
        const url = `${baseUrl}?model=${model}`;

        this.logger.info(`[TTS Realtime] 连接到: ${url.replace(apiKey, '***')}`);

        const logger = this.logger; // 保存logger引用以便在闭包中使用
        
        return new Promise((resolve, reject) => {
            const audioChunks: Buffer[] = [];
            let sessionId: string | null = null;
            let isTextSent = false;

            const ws = new WS(url, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'OpenAI-Beta': 'realtime=v1'
                }
            });

            ws.on('open', () => {
                logger.info('[TTS Realtime] 连接已建立');
                
                // 发送session.update配置
                const sessionUpdate = {
                    event_id: `event_${Date.now()}`,
                    type: 'session.update',
                    session: {
                        modalities: ['audio'],
                        output_audio_format: 'pcm16',
                        sample_rate: 24000,
                        output_audio_transcription: {
                            language: languageType === 'Chinese' ? 'zh' : 'en'
                        },
                        voice: voice
                    }
                };
                
                ws.send(JSON.stringify(sessionUpdate));
                logger.debug('[TTS Realtime] 发送session.update');
            });

            ws.on('message', (data: Buffer | string) => {
                try {
                    const textData = typeof data === 'string' ? data : data.toString('utf8');
                    const json = JSON.parse(textData);
                    
                    // 移除频繁的消息类型日志，减少噪音
                    // logger.debug('[TTS Realtime] 收到消息: %s', json.type);

                    if (json.type === 'session.created') {
                        sessionId = json.session?.id || null;
                        logger.info('[TTS Realtime] 会话已创建: %s', sessionId);
                        // 不在这里发送文本，等待session.updated
                    } else if (json.type === 'session.updated') {
                        logger.info('[TTS Realtime] 会话已更新');
                        // 开始发送文本
                        if (!isTextSent) {
                            isTextSent = true;
                            sendText();
                        }
                    } else if (json.type === 'response.created') {
                        logger.info('[TTS Realtime] 响应已创建，开始接收音频');
                    } else if (json.type === 'response.audio.delta') {
                        // 接收音频分片
                        if (json.delta) {
                            const audioChunk = Buffer.from(json.delta, 'base64');
                            audioChunks.push(audioChunk);
                            // 完全移除频繁的音频分片日志
                            // logger.debug('[TTS Realtime] 收到音频分片: %d bytes', audioChunk.length);
                        }
                    } else if (json.type === 'response.audio.done') {
                        // 音频生成完成
                        logger.info('[TTS Realtime] 音频生成完成，总大小: %d bytes', 
                            audioChunks.reduce((sum, chunk) => sum + chunk.length, 0));
                        
                        // 合并所有音频分片
                        const fullAudio = Buffer.concat(audioChunks);
                        
                        // 发送session.finish并关闭连接
                        const finishEvent = {
                            event_id: `event_${Date.now()}`,
                            type: 'session.finish'
                        };
                        ws.send(JSON.stringify(finishEvent));
                        
                        setTimeout(() => {
                            ws.close();
                            resolve(fullAudio);
                        }, 100);
                    } else if (json.type === 'error') {
                        logger.error('[TTS Realtime] 错误: %s', JSON.stringify(json));
                        ws.close();
                        reject(new Error(`TTS错误: ${json.error?.message || JSON.stringify(json)}`));
                    }
                } catch (e: any) {
                    logger.error('[TTS Realtime] 处理消息失败: %s', e.message);
                }
            });

            ws.on('error', (err: Error) => {
                logger.error('[TTS Realtime] 连接错误: %s', err.message);
                reject(err);
            });

            ws.on('close', (code: number, reason: Buffer) => {
                logger.info(`[TTS Realtime] 连接关闭: ${code} - ${reason?.toString() || ''}`);
            });

            // 发送文本到缓冲区
            function sendText() {
                // 将文本分块发送（每次最多一定长度）
                const chunkSize = 100; // 每次发送100个字符
                let offset = 0;
                
                function sendChunk() {
                    if (offset >= text.length) {
                        // 所有文本已发送，发送commit触发合成
                        const commitEvent = {
                            event_id: `event_${Date.now()}`,
                            type: 'input_text_buffer.commit'
                        };
                        ws.send(JSON.stringify(commitEvent));
                        logger.info('[TTS Realtime] 文本发送完成，发送commit');
                        return;
                    }

                    const chunk = text.substring(offset, offset + chunkSize);
                    const appendEvent = {
                        event_id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                        type: 'input_text_buffer.append',
                        text: chunk
                    };
                    
                    ws.send(JSON.stringify(appendEvent));
                    logger.debug('[TTS Realtime] 发送文本块: %s', chunk.substring(0, 50));
                    
                    offset += chunkSize;
                    
                    // 继续发送下一块
                    setTimeout(sendChunk, 10);
                }
                
                sendChunk();
            }
        });
    }

    /**
     * 完整的语音对话流程：接收音频 -> ASR -> AI -> TTS -> 返回音频
     */
    async voiceChat(audioData: Buffer | string, format = 'wav', conversationHistory: Array<{ role: string; content: string }> = []): Promise<{ text: string; audio: Buffer; aiResponse: string }> {
        // 1. ASR: 语音转文字
        this.logger.info('开始ASR转换...');
        const text = await this.asr(audioData, format);
        this.logger.info('ASR结果: %s', text);

        // 2. AI对话
        this.logger.info('开始AI对话...');
        const aiResponse = await this.chat(text, conversationHistory);
        this.logger.info('AI回复: %s', aiResponse);

        // 3. TTS: 文字转语音
        this.logger.info('开始TTS转换...');
        const audio = await this.tts(aiResponse);
        this.logger.info('TTS完成，音频大小: %d bytes', audio.length);

        return {
            text,
            audio,
            aiResponse,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.plugin(VoiceService);
}

