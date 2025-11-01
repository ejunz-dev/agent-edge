import { ConnectionHandler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import { ClientConnectionHandler } from './client';

const logger = new Logger('asr-proxy');

/**
 * WebSocket代理handler，用于转发浏览器客户端的实时ASR请求到Qwen ASR服务
 * 因为浏览器WebSocket不支持自定义headers，需要在服务器端添加Authorization header
 */
export class AsrProxyConnectionHandler extends ConnectionHandler<Context> {
    private upstream?: import('ws');
    private upstreamUrl = '';
    private currentTranscription = ''; // 当前转录文本
    private clientConnection: any = null; // 关联的client connection

    async prepare() {
        // 从配置中读取ASR配置
        const voiceConfig = (config as any).voice || {};
        const asrConfig = voiceConfig.asr || {};
        
        if (asrConfig.provider !== 'qwen-realtime') {
            this.send({ error: 'ASR proxy only supports qwen-realtime provider' });
            this.close?.(1000, 'asr-proxy: unsupported provider');
            return;
        }

        if (!asrConfig.apiKey) {
            this.send({ error: 'ASR apiKey not configured' });
            this.close?.(1000, 'asr-proxy: apiKey missing');
            return;
        }

        // 构建Qwen ASR WebSocket URL
        // 官方格式：wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=xxx
        const model = asrConfig.model || 'qwen3-asr-flash-realtime';
        const baseUrl = asrConfig.baseUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
        this.upstreamUrl = `${baseUrl}?model=${model}`;

        logger.info(`[ASR代理] 连接到上游: ${this.upstreamUrl.replace(asrConfig.apiKey, '***')}`);

        let WS: any;
        try {
            WS = require('ws');
        } catch (e) {
            logger.error('ws module not found, please add dependency "ws"');
            this.send({ error: 'server missing ws dependency' });
            this.close?.(1011, 'asr-proxy: ws module missing');
            return;
        }

        // 创建到Qwen ASR的WebSocket连接，添加Authorization header
        // 根据官方文档，需要Authorization和OpenAI-Beta header
        const upstream = new WS(this.upstreamUrl, {
            headers: {
                'Authorization': `Bearer ${asrConfig.apiKey}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });
        this.upstream = upstream;

        upstream.on('open', () => {
            logger.info('[ASR代理] 上游连接已建立，通知客户端');
            
            // 监听第一个来自上游的消息（通常是session相关的响应）
            const firstMessageHandler = (data: Buffer | string) => {
                logger.info('[ASR代理] 收到上游第一个消息');
                upstream.removeListener('message', firstMessageHandler);
            };
            upstream.once('message', firstMessageHandler);
            
            // 发送连接成功消息到客户端
            try {
                this.send({ type: 'connection.opened' });
            } catch (e: any) {
                logger.error('[ASR代理] 发送连接确认失败: %s', e.message);
            }
        });

        upstream.on('message', (data: Buffer | string) => {
            // 转发上游消息到客户端
            try {
                // Qwen ASR返回的消息可能是Buffer格式的JSON字符串，需要先转换为字符串
                let text: string;
                if (Buffer.isBuffer(data)) {
                    // 二进制数据，尝试转换为UTF-8字符串
                    text = data.toString('utf8');
                    logger.debug('[ASR代理] 收到上游二进制消息 (%d bytes)，转换为文本', data.length);
                } else {
                    text = typeof data === 'string' ? data : String(data);
                }
                
                // 尝试解析JSON
                try {
                    const json = JSON.parse(text);
                    const jsonStr = JSON.stringify(json);
                    logger.info('[ASR代理] 收到上游消息: %s (长度: %d)', json.type || 'unknown', jsonStr.length);
                    // 如果消息很长，只记录前500个字符
                    if (jsonStr.length > 500) {
                        logger.debug('[ASR代理] 消息内容: %s...', jsonStr.substring(0, 500));
                    } else {
                        logger.info('[ASR代理] 消息内容: %s', jsonStr);
                    }
                    
                    // 特别关注错误消息和会话响应
                    if (json.type === 'error' || json.type === 'session.updated' || json.error) {
                        logger.warn('[ASR代理] 重要消息: %s', jsonStr);
                    }
                    
                    // 处理流式转录delta（实时更新）
                    if (json.type === 'conversation.item.input_audio_transcription.delta') {
                        const delta = json.delta || '';
                        if (delta) {
                            this.currentTranscription += delta;
                            logger.debug('[ASR代理] 转录delta: %s (当前: %s)', delta, this.currentTranscription);
                        }
                    }
                    
                    // 处理转录文本更新（Qwen ASR使用stash字段）
                    if (json.type === 'conversation.item.input_audio_transcription.text') {
                        const displayText = json.stash || json.text || '';
                        if (displayText) {
                            this.currentTranscription = displayText;
                            logger.debug('[ASR代理] 转录文本更新: %s', displayText);
                            
                            // 流式模式：实时转发当前转录文本到AI API（如果达到一定长度或停顿）
                            // 这里可以设置一个阈值，比如每100个字符或每2秒转发一次
                            // 暂时先不实时转发，等待completed事件
                        }
                    }
                    
                    // 处理转录完成：server自动转发到AI API
                    if (json.type === 'conversation.item.input_audio_transcription.completed') {
                        const finalText = json.transcript || this.currentTranscription;
                        logger.info('[ASR代理] 转录完成: %s', finalText);
                        
                        if (finalText && finalText.trim()) {
                            // server自动转发到AI API，不需要client参与
                            this.handleTranscriptionComplete(finalText.trim());
                        }
                        
                        // 仍然转发给客户端（用于显示）
                        this.send(json);
                        
                        // 清空转录状态，准备下一次
                        this.currentTranscription = '';
                        return;
                    }
                    
                    // 转发JSON对象给客户端
                    this.send(json);
                } catch {
                    // 不是JSON，直接转发字符串
                    logger.debug('[ASR代理] 收到上游非JSON消息: %s', text.substring(0, 100));
                    this.send(text);
                }
            } catch (e: any) {
                logger.error('[ASR代理] 转发消息失败: %s', e.message);
            }
        });

        upstream.on('error', (err: Error) => {
            logger.error('[ASR代理] 上游连接错误: %s', err.message);
            this.send({ type: 'error', error: { message: err.message } });
        });

        upstream.on('close', (code: number, reason: Buffer) => {
            const reasonStr = reason ? (Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason)) : '';
            logger.warn(`[ASR代理] 上游连接关闭: ${code} - ${reasonStr || '(无原因)'}`);
            // code 1005通常表示连接意外关闭（没有收到关闭帧）
            // 这可能是因为Qwen ASR没有收到session.update或音频数据
            if (code === 1005) {
                logger.warn('[ASR代理] 连接意外关闭，可能是未发送session.update或超时');
            }
            // 不立即关闭客户端连接，让客户端处理
            this.send({ type: 'connection.closed', code, reason: reasonStr });
        });
    }

    async message(msg: any) {
        // 处理客户端的录音完成通知
        let msgObj: any;
        if (typeof msg === 'string') {
            try {
                msgObj = JSON.parse(msg);
            } catch {
                msgObj = null;
            }
        } else if (!Buffer.isBuffer(msg)) {
            msgObj = msg;
        }
        
        // 处理录音开始通知（client自定义消息，不转发到ASR服务器）
        if (msgObj && msgObj.type === 'recording.started') {
            logger.info('[ASR代理] 收到录音开始通知（仅server处理，不转发）');
            // 清空之前的转录状态，准备接收新的流式转录
            this.currentTranscription = '';
            return; // 不转发此消息到ASR服务器
        }
        
        // 如果是录音完成通知（client自定义消息，不转发到ASR服务器）
        if (msgObj && msgObj.type === 'recording.completed') {
            logger.info('[ASR代理] 收到录音完成通知，强制commit识别（仅server处理，不转发）');
            if (this.upstream && this.upstream.readyState === 1) {
                // 发送ASR标准commit事件（不是client的自定义消息）
                const commitEvent = {
                    event_id: `event_${Date.now()}`,
                    type: 'input_audio_buffer.commit'
                };
                try {
                    this.upstream.send(JSON.stringify(commitEvent));
                    logger.debug('[ASR代理] 已发送commit事件到ASR服务器，强制完成转录');
                } catch (e: any) {
                    logger.error('[ASR代理] 发送commit事件失败: %s', e.message);
                }
            } else {
                logger.warn('[ASR代理] 上游未连接，无法发送commit事件');
            }
            return; // 不转发client的自定义消息到ASR服务器
        }
        
        // 转发客户端消息到上游（只有标准ASR消息才转发）
        if (!this.upstream || this.upstream.readyState !== 1) {
            logger.warn('[ASR代理] 上游未连接，丢弃消息');
            return;
        }

        try {
            // 再次检查是否是自定义消息类型（防止遗漏）
            let finalMsgObj: any = msgObj;
            if (!finalMsgObj && typeof msg === 'string') {
                try {
                    finalMsgObj = JSON.parse(msg);
                } catch {
                    // 不是JSON，继续处理
                }
            }
            
            // 如果发现是自定义消息，不应该转发
            if (finalMsgObj && (finalMsgObj.type === 'recording.started' || finalMsgObj.type === 'recording.completed')) {
                logger.warn('[ASR代理] 检测到自定义消息但已在拦截逻辑后，不应该到达这里: %s', finalMsgObj.type);
                return; // 不转发
            }
            
            let dataToSend: string | Buffer;
            if (typeof msg === 'string') {
                dataToSend = msg;
                // 尝试解析JSON以便记录
                try {
                    const json = JSON.parse(msg);
                    // 再次确认不是自定义消息
                    if (json.type !== 'recording.started' && json.type !== 'recording.completed') {
                        logger.debug('[ASR代理] 转发客户端消息到上游: %s', json.type || 'unknown');
                    }
                } catch {
                    logger.debug('[ASR代理] 转发客户端字符串消息到上游');
                }
            } else if (Buffer.isBuffer(msg)) {
                dataToSend = msg;
                logger.debug('[ASR代理] 转发客户端二进制消息到上游 (%d bytes)', msg.length);
            } else {
                // JSON对象，转换为字符串
                // 再次确认不是自定义消息
                if (msgObj && (msgObj.type === 'recording.started' || msgObj.type === 'recording.completed')) {
                    logger.warn('[ASR代理] 检测到自定义消息对象，不应该转发: %s', msgObj.type);
                    return;
                }
                dataToSend = JSON.stringify(msg);
                logger.debug('[ASR代理] 转发客户端消息到上游: %s', msg.type || 'unknown');
            }
            this.upstream.send(dataToSend);
        } catch (e: any) {
            logger.error('[ASR代理] 转发消息到上游失败: %s', e.message);
        }
    }

    /**
     * 处理转录完成：server自动转发到AI API
     */
    private async handleTranscriptionComplete(text: string) {
        try {
            // 找到关联的client connection（通过IP地址匹配）
            const clientIp = this.request?.ip || (this.request as any)?.socket?.remoteAddress;
            
            // 找到同一个IP的client connection
            let clientConn: any = null;
            for (const conn of ClientConnectionHandler.active) {
                const connIp = (conn as any).request?.ip || ((conn as any).request?.socket as any)?.remoteAddress;
                if (connIp === clientIp) {
                    clientConn = conn;
                    break;
                }
            }
            
            // 如果通过IP找不到，尝试使用第一个active connection（单用户场景）
            if (!clientConn && ClientConnectionHandler.active.size === 1) {
                clientConn = Array.from(ClientConnectionHandler.active)[0];
            }
            
            if (!clientConn) {
                logger.warn('[ASR代理] 未找到关联的client connection，无法自动转发到AI');
                return;
            }
            
            // 获取对话历史
            const conversationHistory = (clientConn as any).conversationHistory || [];
            
            // 获取voice service
            const voiceService = (this.ctx as any).voice;
            if (!voiceService) {
                logger.error('[ASR代理] 语音服务未初始化');
                return;
            }
            
            logger.info('[ASR代理] 自动转发转录文本到AI: %s', text);
            
            // 调用AI对话
            const aiResponse = await voiceService.chat(text, conversationHistory);
            
            // 更新对话历史
            if (!(clientConn as any).conversationHistory) {
                (clientConn as any).conversationHistory = [];
            }
            (clientConn as any).conversationHistory.push({ role: 'user', content: text });
            (clientConn as any).conversationHistory.push({ role: 'assistant', content: aiResponse });
            // 只保留最近20条
            if ((clientConn as any).conversationHistory.length > 20) {
                (clientConn as any).conversationHistory = (clientConn as any).conversationHistory.slice(-20);
            }
            
            // 检查是否使用realtime TTS
            const voiceConfig = (config as any).voice || {};
            const ttsConfig = voiceConfig.tts || {};
            const model = ttsConfig.model || 'qwen3-tts-flash';
            
            if (model.includes('realtime')) {
                // 使用流式TTS
                logger.info('[ASR代理] 使用流式TTS模式');
                
                // 先发送文本和AI回复
                clientConn.send({
                    key: 'voice_chat',
                    result: {
                        text: text,
                        aiResponse: aiResponse,
                        audio: null,
                        streaming: true,
                    },
                });
                
                // 然后流式发送音频
                try {
                    await (voiceService as any).streamTtsRealtime(
                        aiResponse,
                        { ...ttsConfig, voice: ttsConfig.voice || 'Cherry' },
                        (audioChunk: Buffer) => {
                            clientConn.send({
                                key: 'voice_chat_audio',
                                chunk: audioChunk.toString('base64'),
                            });
                        }
                    );
                    
                    // 发送流式传输完成信号
                    clientConn.send({
                        key: 'voice_chat_audio',
                        done: true,
                    });
                } catch (e: any) {
                    logger.error('[ASR代理] 流式TTS失败，回退到非流式模式: %s', e.message);
                    const audioBuffer = await voiceService.tts(aiResponse);
                    clientConn.send({
                        key: 'voice_chat',
                        result: {
                            text: text,
                            audio: audioBuffer.toString('base64'),
                            aiResponse: aiResponse,
                        },
                    });
                }
            } else {
                // 非流式TTS
                const audioBuffer = await voiceService.tts(aiResponse);
                clientConn.send({
                    key: 'voice_chat',
                    result: {
                        text: text,
                        audio: audioBuffer.toString('base64'),
                        aiResponse: aiResponse,
                    },
                });
            }
        } catch (err: any) {
            logger.error('[ASR代理] 自动转发转录文本到AI失败: %s', err.message);
        }
    }

    async cleanup() {
        if (this.upstream) {
            try {
                this.upstream.close();
            } catch (e) {
                // ignore
            }
            this.upstream = undefined;
        }
        this.currentTranscription = '';
        this.clientConnection = null;
    }
}

export async function apply(ctx: Context) {
    ctx.Connection('asr_proxy', '/asr-proxy', AsrProxyConnectionHandler);
}

