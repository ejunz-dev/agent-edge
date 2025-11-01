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
let hasAttemptedOpenBrowser = false; // 是否已尝试打开浏览器
let connectionCheckTimer: NodeJS.Timeout | null = null; // 连接检查定时器

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

    // 创建 HTTP 服务器（同时处理音频播放器和 VTuber 路由）
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

    // 创建 WebSocket 服务器（使用 /audio-ws 路径）
    wss = new WebSocket.Server({ server: httpServer, path: '/audio-ws' });

    wss.on('connection', (ws: any, req: any) => {
        logger.info('前端音频播放器已连接: %s', req.url);
        clientWs = ws;
        
        // 清除连接检查定时器（已连接，不需要再检查）
        if (connectionCheckTimer) {
            clearTimeout(connectionCheckTimer);
            connectionCheckTimer = null;
        }
        hasAttemptedOpenBrowser = true; // 标记已连接，不需要再打开浏览器

        ws.on('message', (data) => {
            // 可以处理前端发送的消息（如果需要）
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'ready') {
                    logger.info('前端播放器已就绪');
                } else if (msg.type === 'playback_complete') {
                    // 前端播放器通知音频真正播放完成
                    logger.debug('前端播放器通知：音频播放已完成');
                    // 通知 voice.ts 停止动画
                    try {
                        const { VoiceClient } = require('./voice');
                        VoiceClient.notifyPlaybackComplete();
                    } catch (err: any) {
                        logger.debug('通知播放完成失败: %s', err.message);
                    }
                }
            } catch {
                // 忽略非 JSON 消息
            }
        });

        ws.on('close', () => {
            logger.warn('前端音频播放器已断开，等待重连...');
            if (clientWs === ws) {
                clientWs = null;
            }
            
            // 断连后，尝试重新打开浏览器（如果页面被关闭）
            // 等待3秒，看是否会自动重连（页面可能还在，只是暂时断开）
            connectionCheckTimer = setTimeout(() => {
                if (!clientWs || !isPlayerConnected()) {
                    logger.info('检测到播放器未重连，尝试重新打开播放器页面...');
                    openBrowserPage();
                }
            }, 3000);
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
        
        // 先等待一小段时间，检查是否有已打开的播放器页面自动连接
        setTimeout(() => {
            if (isPlayerConnected()) {
                logger.info('检测到已打开的播放器页面已连接，无需打开新窗口');
                hasAttemptedOpenBrowser = true;
                return;
            }
            
            // 如果没有连接，尝试打开浏览器
            logger.info('未检测到已连接的播放器，尝试打开播放器页面...');
            openBrowserPage();
        }, 2000); // 等待2秒，给已打开的页面时间连接
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
 * 获取 HTTP 服务器实例（供其他模块共享）
 */
export function getHttpServer(): http.Server | null {
    return httpServer;
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
        clientWs.send(JSON.stringify({
            type: 'audio_chunk',
            chunk: chunkBase64
        }));
        // 音频分片已成功转发，不再记录日志以减少噪音
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
 * 打开浏览器页面（辅助函数）
 */
function openBrowserPage(): void {
    if (hasAttemptedOpenBrowser) {
        // 已经尝试过打开，可能是用户关闭了页面，允许再次打开
        logger.debug('重新打开播放器页面...');
    }
    
    const url = `http://localhost:${CLIENT_PORT}/audio-player`;
    try {
        const platform = os.platform();
        if (platform === 'win32') {
            spawn('cmd', ['/c', 'start', url], { stdio: 'ignore' });
        } else if (platform === 'darwin') {
            spawn('open', [url], { stdio: 'ignore' });
        } else {
            spawn('xdg-open', [url], { stdio: 'ignore' });
        }
        hasAttemptedOpenBrowser = true;
        logger.info('已打开播放器页面: %s', url);
    } catch (err: any) {
        logger.warn('打开播放器页面失败: %s', err.message);
    }
}

/**
 * 启动音频播放器服务器（延迟启动，由外部调用）
 */
export function startPlayerServer(): void {
    if (httpServer) {
        // 服务器已运行，检查连接状态
        if (isPlayerConnected()) {
            logger.debug('音频播放器服务器已在运行，播放器已连接');
            return;
        } else {
            logger.info('音频播放器服务器已在运行，但播放器未连接，等待重连...');
            // 等待3秒后如果还没连接，尝试重新打开
            if (connectionCheckTimer) {
                clearTimeout(connectionCheckTimer);
            }
            connectionCheckTimer = setTimeout(() => {
                if (!isPlayerConnected()) {
                    logger.info('播放器仍未连接，尝试重新打开播放器页面...');
                    openBrowserPage();
                }
            }, 3000);
            return;
        }
    }
    
    try {
        hasAttemptedOpenBrowser = false; // 重置标记
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

