import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils';

const logger = new Logger('audio-player');

// HTTP Handler：提供音频播放器页面
class AudioPlayerPageHandler extends Handler<Context> {
    async get() {
        const htmlPath = path.join(__dirname, '../client/audio-player.html');
        if (fs.existsSync(htmlPath)) {
            this.response.type = 'text/html';
            this.response.body = fs.readFileSync(htmlPath, 'utf8');
        } else {
            this.response.status = 404;
            this.response.body = '音频播放器页面未找到';
        }
    }
}

// WebSocket Handler：音频数据转发
export class AudioPlayerConnectionHandler extends ConnectionHandler<Context> {
    async prepare() {
        logger.info('音频播放器 WebSocket 已连接');
        
        // 将连接保存到全局，供 voice.ts 使用
        (global as any).audioPlayerWs = this;
        
        // 发送就绪消息
        this.send({ type: 'ready' });
    }
    
    async cleanup() {
        logger.info('音频播放器 WebSocket 已断开');
        if ((global as any).audioPlayerWs === this) {
            (global as any).audioPlayerWs = null;
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('audio-player-page', '/audio-player', AudioPlayerPageHandler);
    ctx.Connection('audio-player-ws', '/audio-ws', AudioPlayerConnectionHandler);
}

