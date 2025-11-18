import { Logger } from '@ejunz/utils';
import { getVTubeStudioClient, initVTubeStudioClient } from './vtuber-vtubestudio';
import { getOSCBridge } from './vtuber-osc-bridge';

const logger = new Logger('vtuber-server');

/**
 * VTuber 控制指令接口
 */
export interface VTuberControl {
    type: 'action' | 'expression' | 'speaking' | 'reset';
    // 动作控制
    action?: {
        name: string; // 动作名称，如 'wave', 'nod', 'shake_head', 'point', 'idle' 等
        duration?: number; // 动作持续时间（毫秒），默认 2000
        intensity?: number; // 动作强度（0-1），默认 0.5
        blend?: boolean; // 是否与其他动作混合，默认 false
    };
    // 表情控制
    expression?: {
        emotion: string; // 表情类型，如 'happy', 'sad', 'angry', 'surprised', 'neutral', 'excited' 等
        intensity?: number; // 表情强度（0-1），默认 0.7
        blendTime?: number; // 表情过渡时间（毫秒），默认 500
    };
    // 说话状态控制
    speaking?: {
        isSpeaking: boolean; // 是否在说话
        volume?: number; // 音量（0-1），用于嘴型同步
        pitch?: number; // 音调（0-1），用于嘴型同步
    };
    // 重置到默认状态
    reset?: {
        action: boolean; // 是否重置动作
        expression: boolean; // 是否重置表情
    };
    // 时间戳（可选）
    timestamp?: number;
}

/**
 * 发送 VTuber 控制指令
 */
export function sendVTuberControl(control: VTuberControl): void {
    // 优先发送到 VTube Studio
    const vtsClient = getVTubeStudioClient();
    if (vtsClient && vtsClient.isConnected()) {
        vtsClient.applyControl(control);
        return;
    }

    // 如果没有 VTube Studio，使用 OSC 桥接器（桌面版 VTuber，如 VSeeFace）
    const oscBridge = getOSCBridge();
    if (oscBridge) {
        oscBridge.handleControl(control);
    }
}

/**
 * 批量发送控制指令
 */
export function sendVTuberControls(controls: VTuberControl[]): void {
    controls.forEach(control => sendVTuberControl(control));
}

/**
 * 检查 VTuber 客户端是否已连接
 */
export function isVTuberClientConnected(): boolean {
    const vtsClient = getVTubeStudioClient();
    return vtsClient !== null && vtsClient.isConnected();
}

/**
 * 启动 VTuber 控制（连接到 VTube Studio）
 */
export async function startVTuberServer(ctx?: any): Promise<void> {
    try {
        // 从配置中读取 VTube Studio 设置
        const config = require('../config').config;
        const vtuberConfig = config.vtuber || {};
        const vtsConfig = vtuberConfig.vtubestudio || {};

        // 先尝试从数据库加载认证令牌（在连接之前）
        logger.info('正在从数据库加载认证令牌...');
        let authToken: string | null = null;
        try {
            // 优先尝试直接从本地数据库读取（client 模式）
            // 尝试多种方式获取 Context 和数据库
            const context = ctx || (global as any).__cordis_ctx;
            let db: any = null;
            
            if (context) {
                // 方式1: 通过 ctx.db 访问
                if ((context as any).db && (context as any).db.vtuberAuthToken) {
                    db = (context as any).db;
                }
                // 方式2: 通过 ctx.dbservice.db 访问
                else if ((context as any).dbservice && (context as any).dbservice.db && (context as any).dbservice.db.vtuberAuthToken) {
                    db = (context as any).dbservice.db;
                }
            }
            
            if (db && db.vtuberAuthToken) {
                const host = vtsConfig.host || '127.0.0.1';
                const port = vtsConfig.port || 8001;
                const docId = `${host}:${port}`;
                
                try {
                    const doc = await db.vtuberAuthToken.findOne({ _id: docId });
                    if (doc && doc.authToken) {
                        authToken = doc.authToken;
                        logger.info('✓ 从本地数据库加载到认证令牌');
                    } else {
                        logger.debug('本地数据库中未找到认证令牌（可能需要首次认证）');
                    }
                } catch (dbErr: any) {
                    logger.debug('从本地数据库读取认证令牌失败: %s', dbErr.message);
                }
            } else {
                logger.debug('数据库服务未就绪，将通过 WebSocket 请求令牌');
            }
            
            // 如果本地数据库读取失败，尝试通过 WebSocket 请求（向后兼容）
            if (!authToken) {
                const { getGlobalWsConnection } = require('./client');
                const ws = getGlobalWsConnection();
                if (ws && ws.readyState === 1) {
                    // 直接从数据库读取 token，等待更长时间（30秒）
                    authToken = await new Promise<string | null>((resolve) => {
                        const timeout = setTimeout(() => {
                            ws.removeListener('message', handler);
                            logger.debug('读取认证令牌超时（30秒内未收到响应）');
                            resolve(null);
                        }, 30000); // 增加到 30 秒
                        
                        const handler = (data: any) => {
                            try {
                                let msg: any;
                                if (typeof data === 'string') {
                                    msg = JSON.parse(data);
                                } else if (Buffer.isBuffer(data)) {
                                    msg = JSON.parse(data.toString('utf8'));
                                } else {
                                    msg = data;
                                }
                                
                                if (msg && msg.key === 'vtuber_auth_token_get') {
                                    clearTimeout(timeout);
                                    ws.removeListener('message', handler);
                                    resolve(msg.authToken || null);
                                }
                            } catch (err) {
                                // 忽略解析错误
                            }
                        };
                        
                        ws.on('message', handler);
                        ws.send(JSON.stringify({
                            key: 'vtuber_auth_token_get',
                            host: vtsConfig.host || '127.0.0.1',
                            port: vtsConfig.port || 8001,
                        }));
                    });
                    
                    if (authToken) {
                        logger.info('✓ 通过 WebSocket 从数据库加载到认证令牌');
                    } else {
                        logger.debug('数据库中未找到认证令牌（可能需要首次认证）');
                    }
                } else {
                    logger.debug('WebSocket 未连接，将使用空 token（稍后可能需要首次认证）');
                }
            }
        } catch (err: any) {
            logger.debug('从数据库读取认证令牌失败（将稍后重试）: %s', err.message);
        }
        
        // 初始化客户端（使用从数据库加载的 token，如果有）
        const client = initVTubeStudioClient({
            host: vtsConfig.host || '127.0.0.1',
            port: vtsConfig.port || 8001,
            apiName: vtsConfig.apiName || 'Agent Edge VTuber Control',
            apiVersion: vtsConfig.apiVersion || '1.0',
            authToken: authToken || undefined,
        });
        
        if (authToken) {
            logger.info('正在连接到 VTube Studio（使用数据库中的认证令牌）...');
        } else {
            logger.info('正在连接到 VTube Studio...');
            logger.info('提示：如果是首次连接，请在 VTube Studio 中授权此插件');
        }
    } catch (err: any) {
        logger.error('启动 VTube Studio 客户端失败: %s', err.message);
    }
}

/**
 * 停止 VTuber 控制
 */
export function stopVTuberServer(): void {
    const vtsClient = getVTubeStudioClient();
    if (vtsClient) {
        vtsClient.disconnect();
        logger.info('VTube Studio 客户端已断开');
    }
}

// 进程退出时清理
process.on('exit', () => {
    stopVTuberServer();
});

process.on('SIGINT', () => {
    stopVTuberServer();
    setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
    stopVTuberServer();
    setTimeout(() => process.exit(0), 1000);
});

