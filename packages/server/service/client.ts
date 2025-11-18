// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';
import * as path from 'node:path';
import { fs, yaml } from '../utils';
import { startConnecting, setGlobalWsConnection } from '../client/client';

const logger = new Logger('client-service');

/**
 * Client 服务
 * 管理客户端连接和配置重载
 */
export default class ClientService extends Service<Context> {
    private dispose: (() => void) | null = null;

    constructor(ctx: Context) {
        super(ctx, 'client');
    }

    async [Service.init](): Promise<void> {
        if (!process.argv.includes('--client')) {
            return;
        }

        logger.info('初始化客户端连接...');
        this.dispose = startConnecting(this.ctx);
    }

    async [Service.dispose](): Promise<void> {
        logger.info('正在断开客户端连接...');
        
        // 停止 VTube Studio 服务
        try {
            const { stopVTuberServer } = require('../client/vtuber-server');
            if (stopVTuberServer) {
                stopVTuberServer();
            }
        } catch (err: any) {
            logger.debug('停止 VTube Studio 服务失败: %s', err.message);
        }
        
        if (this.dispose) {
            try {
                this.dispose();
            } catch (err: any) {
                logger.warn('断开连接时出错: %s', err.message);
            }
            this.dispose = null;
        }

        // 清理全局连接
        setGlobalWsConnection(null);
    }

    /**
     * 重新加载配置并重新连接
     */
    async reloadConfig(): Promise<void> {
        logger.info('正在重新加载配置...');
        
        // 断开现有连接
        await this[Service.dispose]();
        
        // 等待一下，确保连接完全关闭
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 重新读取配置文件并应用 schema 验证（参考 mqtt-bridge 的实现）
        const configPath = path.resolve(process.cwd(), 'config.client.yaml');
        if (fs.existsSync(configPath)) {
            const configData = yaml.load(fs.readFileSync(configPath, 'utf8'));
            
            // 更新内存中的配置（完整替换，确保能正确读取 false 值）
            if (typeof configData.server === 'string') {
                (config as any).server = configData.server;
            }
            if (typeof configData.port === 'number') {
                (config as any).port = configData.port;
            }
            
            // 更新 voice.vtuber 配置（完整替换，确保 enabled: false 能正确应用）
            if (configData.voice) {
                if (!(config as any).voice) (config as any).voice = {};
                if (configData.voice.vtuber !== undefined) {
                    // 如果配置中有 vtuber，完整替换（包括 enabled: false）
                    // 先保留现有配置作为默认值，然后用文件中的配置覆盖
                    const currentVtuber = (config as any).voice.vtuber || {};
                    (config as any).voice.vtuber = {
                        ...currentVtuber,
                        ...configData.voice.vtuber,
                        // 确保 enabled 字段被正确覆盖（即使是 false）
                        enabled: configData.voice.vtuber.enabled !== undefined 
                            ? configData.voice.vtuber.enabled 
                            : currentVtuber.enabled,
                        engine: configData.voice.vtuber.engine !== undefined 
                            ? configData.voice.vtuber.engine 
                            : currentVtuber.engine,
                    };
                }
            }
        }
        
        // 重新初始化连接
        await this[Service.init]();
        
        logger.success('配置重新加载完成');
    }
}

declare module 'cordis' {
    interface Context {
        client: ClientService;
    }
}

