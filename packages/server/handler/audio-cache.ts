import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { Logger } from '../utils';

const logger = new Logger('audio-cache');

// 流式音频缓存拉取Handler
class AudioCacheStreamHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        const audioId = this.request.query.audioId as string;
        
        if (!audioId) {
            this.response.status = 400;
            this.response.body = { error: '缺少audioId参数' };
            return;
        }

        const voiceService = this.ctx.get('voice') as any;
        if (!voiceService) {
            this.response.status = 500;
            this.response.body = { error: 'Voice service未找到' };
            return;
        }

        try {
            logger.info(`[AudioCache] GET请求: audioId=${audioId}`);
            
            // 检查缓存状态
            const status = voiceService.getAudioCacheStatus(audioId);
            if (!status) {
                logger.warn(`[AudioCache] 缓存不存在: ${audioId}`);
                this.response.status = 404;
                this.response.type = 'application/json';
                this.response.body = { error: '音频缓存不存在' };
                return;
            }

            logger.info(`[AudioCache] 缓存状态: ${status.status}, 大小: ${status.totalLength} bytes`);

            if (status.status === 'generating') {
                // 还在生成中，但返回已有数据（支持边缓存边播放）
                logger.info(`[AudioCache] 音频正在生成中，返回已有数据: ${status.totalLength} bytes`);
                
                // 设置响应头（流式传输）
                this.response.status = 200;
                this.response.type = 'audio/pcm';
                this.response.addHeader('Content-Type', 'audio/pcm');
                this.response.addHeader('X-Audio-Status', 'generating'); // 标记为生成中
                this.response.addHeader('Accept-Ranges', 'bytes');
                
                // 返回已有数据
                try {
                    const audioStream = voiceService.getAudioCacheStream(audioId, true); // 允许generating状态
                    const audioChunks: Buffer[] = [];
                    
                    // 收集所有已有音频块
                    for (const chunk of audioStream) {
                        audioChunks.push(chunk);
                    }
                    
                    // 合并所有音频块并发送
                    if (audioChunks.length > 0) {
                        const currentAudio = Buffer.concat(audioChunks);
                        this.response.body = currentAudio;
                        logger.info(`[AudioCache] 发送已有数据: ${audioId}, ${currentAudio.length} bytes (生成中)`);
                    } else {
                        this.response.body = Buffer.alloc(0);
                        logger.info(`[AudioCache] 暂无数据: ${audioId} (生成中)`);
                    }
                } catch (e: any) {
                    logger.error(`[AudioCache] 处理失败: ${audioId}, ${e.message}`);
                    this.response.status = 500;
                    this.response.type = 'application/json';
                    this.response.body = { error: e.message };
                }
                return;
            }

            if (status.status === 'error') {
                logger.error(`[AudioCache] 音频生成错误: ${status.error}`);
                this.response.status = 500;
                this.response.type = 'application/json';
                this.response.body = { error: status.error || '音频生成失败' };
                return;
            }

            if (status.status !== 'ready') {
                logger.warn(`[AudioCache] 音频状态异常: ${status.status}`);
                this.response.status = 400;
                this.response.type = 'application/json';
                this.response.body = { error: `音频状态异常: ${status.status}` };
                return;
            }

            // 设置响应头（流式传输）
            this.response.status = 200;
            this.response.type = 'audio/pcm';
            this.response.addHeader('Content-Type', 'audio/pcm');
            this.response.addHeader('Accept-Ranges', 'bytes');
            this.response.addHeader('Cache-Control', 'public, max-age=300'); // 5分钟缓存
            
            // 流式发送音频数据（将所有chunk合并后一次性发送）
            let sentBytes = 0;
            try {
                const audioStream = voiceService.getAudioCacheStream(audioId);
                const audioChunks: Buffer[] = [];
                
                // 收集所有音频块
                for (const chunk of audioStream) {
                    audioChunks.push(chunk);
                    sentBytes += chunk.length;
                }
                
                // 合并所有音频块并发送
                if (audioChunks.length > 0) {
                    const fullAudio = Buffer.concat(audioChunks);
                    this.response.body = fullAudio;
                    logger.info(`[AudioCache] 发送完成: ${audioId}, ${sentBytes} bytes`);
                } else {
                    this.response.body = Buffer.alloc(0);
                    logger.warn(`[AudioCache] 无音频数据: ${audioId}`);
                }
            } catch (e: any) {
                logger.error(`[AudioCache] 处理失败: ${audioId}, ${e.message}`);
                this.response.status = 500;
                this.response.type = 'application/json';
                this.response.body = { error: e.message };
            }
            
        } catch (e: any) {
            logger.error(`[AudioCache] 处理请求失败: ${e.message}`);
            this.response.status = 500;
            this.response.body = { error: e.message };
        }
    }

    // 检查缓存状态
    async post() {
        const { audioId } = this.request.body || {};
        
        if (!audioId) {
            this.response.status = 400;
            this.response.body = { error: '缺少audioId参数' };
            return;
        }

        const voiceService = this.ctx.get('voice') as any;
        if (!voiceService) {
            this.response.status = 500;
            this.response.body = { error: 'Voice service未找到' };
            return;
        }

        const status = voiceService.getAudioCacheStatus(audioId);
        if (!status) {
            this.response.status = 404;
            this.response.body = { error: '音频缓存不存在' };
            return;
        }

        this.response.type = 'application/json';
        this.response.body = status;
    }

    // 删除缓存
    async delete() {
        const audioId = this.request.query.audioId as string;
        
        if (!audioId) {
            this.response.status = 400;
            this.response.body = { error: '缺少audioId参数' };
            return;
        }

        const voiceService = this.ctx.get('voice') as any;
        if (!voiceService) {
            this.response.status = 500;
            this.response.body = { error: 'Voice service未找到' };
            return;
        }

        const deleted = voiceService.deleteAudioCache(audioId);
        this.response.type = 'application/json';
        this.response.body = { deleted };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('audio_cache_stream', '/api/audio-cache', AudioCacheStreamHandler);
    logger.info('Audio cache handler registered: /api/audio-cache');
}

