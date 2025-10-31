import { ConnectionHandler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';

const logger = new Logger('asr-proxy');

/**
 * WebSocket代理handler，用于转发浏览器客户端的实时ASR请求到Qwen ASR服务
 * 因为浏览器WebSocket不支持自定义headers，需要在服务器端添加Authorization header
 */
export class AsrProxyConnectionHandler extends ConnectionHandler<Context> {
    private upstream?: import('ws');
    private upstreamUrl = '';

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
        // 转发客户端消息到上游
        if (!this.upstream || this.upstream.readyState !== 1) {
            logger.warn('[ASR代理] 上游未连接，丢弃消息');
            return;
        }

        try {
            let dataToSend: string | Buffer;
            if (typeof msg === 'string') {
                dataToSend = msg;
                // 尝试解析JSON以便记录
                try {
                    const json = JSON.parse(msg);
                    logger.debug('[ASR代理] 转发客户端消息到上游: %s', json.type || 'unknown');
                } catch {
                    logger.debug('[ASR代理] 转发客户端字符串消息到上游');
                }
            } else if (Buffer.isBuffer(msg)) {
                dataToSend = msg;
                logger.debug('[ASR代理] 转发客户端二进制消息到上游 (%d bytes)', msg.length);
            } else {
                // JSON对象，转换为字符串
                dataToSend = JSON.stringify(msg);
                logger.debug('[ASR代理] 转发客户端消息到上游: %s', msg.type || 'unknown');
            }
            this.upstream.send(dataToSend);
        } catch (e: any) {
            logger.error('[ASR代理] 转发消息到上游失败: %s', e.message);
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
    }
}

export async function apply(ctx: Context) {
    ctx.Connection('asr_proxy', '/asr-proxy', AsrProxyConnectionHandler);
}

