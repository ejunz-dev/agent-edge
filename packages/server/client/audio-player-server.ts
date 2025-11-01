import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

const logger = new Logger('audio-player-server');

// 动态导入 ws（ws 已在 package.json 中）
let WebSocket: any;
try {
    WebSocket = require('ws');
} catch {
    logger.error('ws 模块未安装，音频播放器服务器将无法工作');
}

// 本地 HTTP + WebSocket 服务器，用于 client 模式下的音频播放
let httpServer: http.Server | null = null;
let wss: any = null; // WebSocket.Server
let clientWs: any = null; // 前端播放器的 WebSocket 连接
const CLIENT_PORT = 5284; // client 模式使用的端口（避免与 server 模式冲突）

/**
 * 启动本地音频播放器服务器
 */
function startAudioPlayerServer(): void {
    if (httpServer) {
        logger.debug('音频播放器服务器已在运行');
        return;
    }

    if (!WebSocket) {
        logger.error('ws 模块未安装，无法启动音频播放器服务器。请运行: yarn add ws');
        return;
    }

    // 创建 HTTP 服务器
    httpServer = http.createServer((req, res) => {
        if (req.url === '/audio-player') {
            // 提供播放器页面
            const htmlPath = path.join(__dirname, 'audio-player.html');
            if (fs.existsSync(htmlPath)) {
                fs.readFile(htmlPath, 'utf8', (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('读取播放器页面失败');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(data);
                });
            } else {
                res.writeHead(404);
                res.end('播放器页面未找到');
            }
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    // 创建 WebSocket 服务器
    wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws: any) => {
        logger.info('前端音频播放器已连接');
        clientWs = ws;

        ws.on('message', (data) => {
            // 可以处理前端发送的消息（如果需要）
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'ready') {
                    logger.debug('前端播放器已就绪');
                }
            } catch {
                // 忽略非 JSON 消息
            }
        });

        ws.on('close', () => {
            logger.info('前端音频播放器已断开');
            if (clientWs === ws) {
                clientWs = null;
            }
        });

        ws.on('error', (err: Error) => {
            logger.error('前端音频播放器 WebSocket 错误: %s', err.message);
        });

        // 发送就绪消息
        ws.send(JSON.stringify({ type: 'ready' }));
    });

    // 启动服务器
    httpServer.listen(CLIENT_PORT, '127.0.0.1', () => {
        logger.info('音频播放器服务器已启动: http://localhost:%d/audio-player', CLIENT_PORT);
        
        // 自动打开浏览器
        const url = `http://localhost:${CLIENT_PORT}/audio-player`;
        setTimeout(() => {
            try {
                const platform = os.platform();
                if (platform === 'win32') {
                    spawn('cmd', ['/c', 'start', url], { stdio: 'ignore' });
                } else if (platform === 'darwin') {
                    spawn('open', [url], { stdio: 'ignore' });
                } else {
                    spawn('xdg-open', [url], { stdio: 'ignore' });
                }
            } catch {
                // 忽略错误
            }
        }, 1000);
    });

    httpServer.on('error', (err: Error) => {
        logger.error('音频播放器服务器错误: %s', err.message);
    });
}

/**
 * 停止本地音频播放器服务器
 */
function stopAudioPlayerServer(): void {
    // 关闭 WebSocket 连接
    if (clientWs) {
        try {
            if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
                clientWs.close(1000, 'server shutdown');
            }
        } catch { /* ignore */ }
        clientWs = null;
    }
    
    // 关闭 WebSocket 服务器
    if (wss) {
        try {
            wss.close(() => {
                logger.debug('WebSocket 服务器已关闭');
            });
        } catch { /* ignore */ }
        wss = null;
    }
    
    // 关闭 HTTP 服务器
    if (httpServer) {
        try {
            httpServer.close(() => {
                logger.debug('HTTP 服务器已关闭');
            });
        } catch { /* ignore */ }
        httpServer = null;
    }
}

/**
 * 转发音频分片到前端播放器
 */
export function forwardAudioChunk(chunkBase64: string): boolean {
    if (!WebSocket) {
        logger.debug('WebSocket 模块未加载，无法转发音频');
        return false;
    }
    if (!clientWs) {
        logger.debug('前端播放器未连接，无法转发音频');
        return false;
    }
    if (clientWs.readyState !== WebSocket.OPEN) {
        logger.debug('前端播放器连接状态异常: %d，无法转发音频', clientWs.readyState);
        return false;
    }
    try {
        const chunkSize = chunkBase64 ? chunkBase64.length : 0;
        clientWs.send(JSON.stringify({
            type: 'audio_chunk',
            chunk: chunkBase64
        }));
        logger.debug('已转发音频分片到前端播放器: %d bytes', chunkSize);
        return true;
    } catch (err: any) {
        logger.warn('转发音频分片失败: %s', err.message);
        return false;
    }
}

/**
 * 发送播放完成信号
 */
export function sendPlaybackDone(): void {
    if (!WebSocket) return;
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        try {
            clientWs.send(JSON.stringify({ type: 'done' }));
        } catch (err: any) {
            logger.warn('发送播放完成信号失败: %s', err.message);
        }
    }
}

/**
 * 检查前端播放器是否已连接
 */
export function isPlayerConnected(): boolean {
    if (!WebSocket) return false;
    return clientWs !== null && clientWs.readyState === WebSocket.OPEN;
}

/**
 * 启动音频播放器服务器（延迟启动，由外部调用）
 */
export function startPlayerServer(): void {
    if (httpServer) {
        logger.debug('音频播放器服务器已在运行');
        return;
    }
    
    try {
        startAudioPlayerServer();
    } catch (err: any) {
        logger.error('启动音频播放器服务器失败: %s', err.message);
    }
}

export async function apply(ctx: Context) {
    // 不在启动时自动启动，等待上游连接成功后再启动
    // startPlayerServer() 将由 client.ts 在上游连接成功后调用

    // 优雅关闭：在进程退出时清理
    const cleanup = () => {
        logger.info('清理音频播放器服务器...');
        stopAudioPlayerServer();
        // 给服务器一点时间关闭
        setTimeout(() => {
            // 如果还在运行，强制退出
        }, 500);
    };
    
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
    
    // Windows 上额外监听
    if (process.platform === 'win32') {
        // 监听未捕获的异常，确保清理
        process.on('uncaughtException', (err) => {
            logger.error('未捕获的异常，清理资源: %s', err.message);
            cleanup();
        });
    }
}

