import { Context, Service } from 'cordis';
import superagent from 'superagent';
import { config } from '../config';
import { Logger } from '../utils';

const logger = new Logger('voice');

export interface IVoiceService {
    asr(audioData: Buffer | string, format?: string): Promise<string>;
    tts(text: string, voice?: string): Promise<Buffer>;
    chat(message: string, conversationHistory?: Array<{ role: string; content: string }>): Promise<string>;
}

class VoiceService extends Service implements IVoiceService {
    logger = this.ctx.logger('voice')
    
    // 暴露流式TTS方法供handler调用（公共方法）
    async streamTtsRealtime(text: string, ttsConfig: any, onAudioChunk: (chunk: Buffer) => void): Promise<void> {
        return await this.qwenTtsRealtimeStream(text, ttsConfig, onAudioChunk);
    }
    private voiceConfig: any;

    constructor(ctx: Context) {
        super(ctx, 'voice');
        this.voiceConfig = (config as any).voice || {};
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
     * AI对话
     */
    async chat(message: string, conversationHistory: Array<{ role: string; content: string }> = []): Promise<string> {
        const aiConfig = this.voiceConfig.ai || {};
        if (!aiConfig.provider || !aiConfig.apiKey) {
            throw new Error('AI未配置：请设置 voice.ai.provider 和 voice.ai.apiKey');
        }

        const provider = aiConfig.provider.toLowerCase();
        const endpoint = aiConfig.endpoint || 'https://api.openai.com/v1/chat/completions';
        const model = aiConfig.model || 'gpt-3.5-turbo';
        const authHeader = aiConfig.authHeader || 'Authorization';
        // 注意：空字符串 '' 也是有效值，不应该使用 || 运算符，应该明确检查 undefined
        const authPrefix = aiConfig.authPrefix !== undefined ? aiConfig.authPrefix : 'Bearer';
        const requestFormat = aiConfig.requestFormat || 'openai';

        try {
            if (provider === 'openai' || provider === 'custom' || provider === 'ejunz') {
                // 构建请求
                const request = superagent
                    .post(endpoint)
                    .set('Content-Type', 'application/json');

                // 设置认证Header
                let authValue: string;
                if (authPrefix && authPrefix.trim() !== '') {
                    authValue = `${authPrefix} ${aiConfig.apiKey}`;
                } else {
                    authValue = aiConfig.apiKey;
                }
                
                // 确保API Key没有额外的空格或换行符
                authValue = authValue.trim();
                
                request.set(authHeader, authValue);
                
                // 记录认证信息（隐藏部分key用于调试）
                const maskedKey = aiConfig.apiKey.length > 8 
                    ? `${aiConfig.apiKey.substring(0, 4)}...${aiConfig.apiKey.substring(aiConfig.apiKey.length - 4)}`
                    : '***';
                this.logger.debug('AI请求认证: %s = %s (长度: %d)', authHeader, maskedKey, authValue.length);
                this.logger.debug('AI请求完整认证值: %s = %s', authHeader, authValue.substring(0, 8) + '...' + authValue.substring(authValue.length - 8));

                let requestBody: any;

                if (provider === 'ejunz' || requestFormat === 'simple') {
                    // 简单格式：只发送当前消息
                    // 注意：简单格式无法注入系统提示词，建议在API端配置
                    // 例如: {"message": "Hello"}
                    requestBody = { message };
                    this.logger.debug('使用简单格式发送AI请求到 %s: %s', endpoint, JSON.stringify(requestBody));
                    this.logger.warn('简单格式不支持系统提示词注入，VTuber动画提示词将被跳过。建议在API端配置或使用OpenAI格式。');
                } else {
                    // OpenAI标准格式：包含对话历史
                    const messages = [...conversationHistory];
                    messages.push({ role: 'user', content: message });
                    requestBody = {
                        model,
                        messages,
                        temperature: 0.7,
                    };
                    this.logger.debug('使用OpenAI格式发送AI请求到 %s', endpoint);
                }

                this.logger.debug('AI请求URL: %s', endpoint);
                this.logger.debug('AI请求Headers: Content-Type=application/json, %s=%s', authHeader, maskedKey);

                const response = await request.send(requestBody);
                
                // 记录响应状态
                this.logger.debug('AI响应状态: %s', response.status);
                this.logger.debug('AI响应头: %s', JSON.stringify(response.headers));

                // 解析响应
                const result = response.body;
                
                // 打印完整的响应内容用于调试
                this.logger.info('AI响应内容: %s', JSON.stringify(result, null, 2));
                this.logger.info('AI响应类型: %s', typeof result);
                if (result && typeof result === 'object') {
                    this.logger.info('AI响应字段: %s', Object.keys(result).join(', '));
                }

                // 尝试多种响应格式
                if (result.choices?.[0]?.message?.content) {
                    // OpenAI格式
                    const content = result.choices[0].message.content;
                    this.logger.info('从OpenAI格式提取回复: %s', content);
                    return content;
                } else if (result.message) {
                    // 简单格式：直接返回message字段
                    const content = result.message;
                    this.logger.info('从message字段提取回复: %s', content);
                    return content;
                } else if (result.text) {
                    // 返回text字段
                    const content = result.text;
                    this.logger.info('从text字段提取回复: %s', content);
                    return content;
                } else if (result.response) {
                    // 返回response字段
                    const content = result.response;
                    this.logger.info('从response字段提取回复: %s', content);
                    return content;
                } else if (typeof result === 'string') {
                    // 直接是字符串
                    this.logger.info('响应是字符串: %s', result);
                    return result;
                } else {
                    // 尝试返回整个body的字符串表示
                    this.logger.warn('未知的响应格式，尝试返回JSON字符串: %s', JSON.stringify(result));
                    return JSON.stringify(result);
                }
            } else {
                throw new Error(`不支持的AI provider: ${provider}`);
            }
           } catch (error: any) {
               this.logger.error('AI对话失败: %s', error.message);
               if (error.response) {
                   const errorBody = error.response.body || error.response.text;
                   this.logger.error('AI响应错误: %s', JSON.stringify(errorBody));
                   // 如果是认证错误，提供更详细的调试信息
                   if (error.status === 401 || (errorBody && errorBody.error && errorBody.error.includes('API Key'))) {
                       const maskedKey = aiConfig.apiKey.length > 8 
                           ? `${aiConfig.apiKey.substring(0, 4)}...${aiConfig.apiKey.substring(aiConfig.apiKey.length - 4)}`
                           : '***';
                       this.logger.error('API Key认证失败，请检查: %s = %s', authHeader, maskedKey);
                       this.logger.error('请求URL: %s', endpoint);
                   }
               } else if (error.request) {
                   this.logger.error('AI请求失败，未收到响应: %s', error.message);
               }
               throw new Error(`AI对话失败: ${error.message}`);
           }
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

