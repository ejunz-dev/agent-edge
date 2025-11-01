import { Logger } from '@ejunz/utils';
import { config } from '../config';

const logger = new Logger('voice-tts-realtime');

let WS: any;
try {
    WS = require('ws');
} catch (e) {
    // ws module not available
}

/**
 * 使用WebSocket调用Qwen TTS Realtime
 * 根据文档：https://help.aliyun.com/zh/model-studio/interactive-process-of-qwen-tts-realtime-synthesis
 */
export async function qwenTtsRealtime(text: string, ttsConfig: any): Promise<Buffer> {
    if (!WS) {
        throw new Error('缺少 ws 依赖，请安装: npm install ws');
    }

    const apiKey = ttsConfig.apiKey;
    const model = ttsConfig.model || 'qwen3-tts-flash-realtime';
    const voice = ttsConfig.voice || 'Cherry';
    const languageType = ttsConfig.languageType || 'Chinese';
    
    // Qwen TTS Realtime WebSocket地址
    // 根据文档，应该是类似ASR的格式
    const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
    const url = `${baseUrl}?model=${model}`;

    logger.info(`[TTS Realtime] 连接到: ${url.replace(apiKey, '***')}`);

    return new Promise((resolve, reject) => {
        const audioChunks: Buffer[] = [];
        let sessionId: string | null = null;

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
                const text = typeof data === 'string' ? data : data.toString('utf8');
                const json = JSON.parse(text);
                
                logger.debug('[TTS Realtime] 收到消息: %s', json.type);

                if (json.type === 'session.created') {
                    sessionId = json.session?.id || null;
                    logger.info('[TTS Realtime] 会话已创建: %s', sessionId);
                    
                    // 开始发送文本
                    sendText();
                } else if (json.type === 'session.updated') {
                    logger.info('[TTS Realtime] 会话已更新');
                    // 开始发送文本
                    sendText();
                } else if (json.type === 'response.created') {
                    logger.info('[TTS Realtime] 响应已创建，开始接收音频');
                } else if (json.type === 'response.audio.delta') {
                    // 接收音频分片
                    if (json.delta) {
                        const audioChunk = Buffer.from(json.delta, 'base64');
                        audioChunks.push(audioChunk);
                        // 移除频繁的音频分片日志，减少噪音
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

