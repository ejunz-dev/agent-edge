import os from 'node:os';
import path from 'node:path';
import LoggerService from '@cordisjs/plugin-logger';
import { TimerService } from '@cordisjs/plugin-timer';
import { Context } from 'cordis';
import DBService from './service/db';
import { fs, Logger } from './utils';

const logger = new Logger('tools');

process.on('unhandledRejection', (e) => { logger.error(e); });
process.on('uncaughtException', (e) => { logger.error(e); });
Error.stackTraceLimit = 50;
const app = new Context();
const tmpdir = path.resolve(os.tmpdir(), 'agent-edge');
fs.ensureDirSync(tmpdir);

let config;
try {
    config = require('./config').config;
} catch (e) {
    if (e.message !== 'no-config') throw e;
}

async function applyServer(ctx: Context) {
    await Promise.all([
        ctx.plugin(require('./service/server')),
        ctx.plugin(require('./service/voice')),
    ]);
        await ctx.inject(['server', 'dbservice', 'voice'], async (c) => {
        await Promise.all([
            c.plugin(require('./handler/misc')),
            c.plugin(require('./handler/mcp')),
            c.plugin(require('./handler/mcp-tools-api')),
            c.plugin(require('./handler/voice-config')),
            c.plugin(require('./handler/edge')),
            // c.plugin(require('./handler/client')), // 注释掉 edge2client
            c.plugin(require('./handler/asr-proxy')),
            c.plugin(require('./handler/zigbee2mqtt')),
            c.plugin(require('./handler/audio-player')),
            c.plugin(require('./handler/audio-cache')),
            c.plugin(require('./handler/node')),
            // CS2 Projection 后端 + UI
            c.plugin(require('./handler/projection-ui')),
        ]);
        
        c.server.listen();
    });
}

async function applyClient(ctx: Context) {
    // 先启动服务器以提供 client-ui
    await ctx.plugin(require('./service/server'));
    // 注册 ClientService
    const clientSvc = require('./service/client');
    ctx.plugin(clientSvc.default || clientSvc);
    
    await ctx.inject(['server'], async (c) => {
        await Promise.all([
            c.plugin(require('./handler/client-ui')),
            // c.plugin(require('./handler/client')), // 注释掉 edge2client
            c.plugin(require('./handler/audio-player')),
        ]);
        
        // 等待服务器启动完成
        await c.server.listen();
        
        // 服务器启动后再启动其他服务
        // 使用事件确保服务器完全就绪
        await new Promise((resolve) => {
            // 给服务器一点时间完全启动
            setTimeout(() => {
                // 启动自动语音交互
                ctx.plugin(require('./client/voice-auto'));
                resolve(undefined);
            }, 300);
        });
    });
}

function applyNode(ctx: Context) {
    // Node 模式：启动 WebService + Zigbee2MQTT + 控制台 + 内置 Broker
    ctx.plugin(require('./service/server'));
    // 内置 MQTT Broker（Aedes）
    const brokerSvc = require('./service/broker');
    ctx.plugin(brokerSvc.default || brokerSvc);
    // 使用 zigbee2mqtt 服务（通过 MQTT 控制设备）
    const zigbee2mqttSvc = require('./service/zigbee2mqtt');
    ctx.plugin(zigbee2mqttSvc.default || zigbee2mqttSvc);
    // MQTT 桥接服务（支持连接多个 broker）
    const mqttBridgeSvc = require('./service/mqtt-bridge');
    ctx.plugin(mqttBridgeSvc.default || mqttBridgeSvc);
    ctx.inject(['server'], (c) => {
        // node-ui 先注册，确保根路径指向 React Dashboard
        c.plugin(require('./handler/node-ui'));
        c.plugin(require('./handler/zigbee2mqtt'));
        c.plugin(require('./handler/mqtt-bridge-config'));
        c.plugin(require('./handler/zigbee-console'));
        c.plugin(require('./handler/node-mcp-tools'));
        c.plugin(require('./handler/node-mcp-provider'));
        c.plugin(require('./handler/node-mcp-config'));
        c.server.listen();
    });
    // node client（仅用于本地 MQTT Broker 连接）
    // 上游 WebSocket 连接已移除，远程 MQTT 连接通过 mqttBridge 配置管理
    ctx.plugin(require('./client/node'));
}

async function applyProvider(ctx: Context) {
    // Provider 模式：启动 MCP Provider 服务器
    await Promise.all([
        ctx.plugin(require('./service/server')),
    ]);
    await ctx.inject(['server', 'dbservice'], async (c) => {
        await Promise.all([
            c.plugin(require('./handler/provider-ui')),
            c.plugin(require('./handler/provider-mcp')),
            c.plugin(require('./handler/provider-tools-config')),
            c.plugin(require('./handler/provider-logs')),
        ]);
        
        c.server.listen();
    });
}

// Projection 模式：专门用于 CS2 GSI 投影（独立启动方式，类似 --node）
async function applyProjection(ctx: Context) {
    // 需要 WebService + DBService + Projection UI/后端
    await ctx.plugin(require('./service/server'));
    ctx.plugin(DBService);
    
    // 启动上游连接（不启动语音输入）
    const { startConnecting } = require('./projection/client');
    const stopConnecting = startConnecting(ctx);
    
    // 保存 server 引用以便关闭
    let serverInstance: any = null;
    
    await ctx.inject(['server', 'dbservice'], async (c) => {
        await Promise.all([
            c.plugin(require('./handler/projection-ui')),
        ]);

        c.server.listen();
        serverInstance = c.server;
    });
    
    // 清理函数（在进程退出时调用）
    let isShuttingDown = false;
    const cleanup = () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        try {
            if (stopConnecting) stopConnecting();
        } catch (e) {
            logger.error('清理上游连接失败: %s', (e as Error).message);
        }
        
        // 关闭服务器
        try {
            if (serverInstance) {
                serverInstance.close(() => {
                    logger.info('服务器已关闭');
                });
            }
        } catch (e) {
            logger.error('关闭服务器失败: %s', (e as Error).message);
        }
    };
    
    // 注册信号处理器
    const handleShutdown = (signal: string) => {
        logger.info('收到 %s 信号，正在关闭...', signal);
        cleanup();
        // 延迟退出，给清理操作时间
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    };
    
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('exit', cleanup);
    
    // Windows 上的特殊处理
    if (process.platform === 'win32') {
        // Windows 上监听 readline 接口（用于 Ctrl+C）
        try {
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            
            rl.on('SIGINT', () => {
                logger.info('收到 Ctrl+C，正在关闭...');
                handleShutdown('SIGINT');
            });
            
            // 保存 rl 引用以便清理
            (global as any).__projection_rl = rl;
        } catch (e) {
            logger.debug('Windows readline 初始化失败: %s', (e as Error).message);
        }
    }
}

async function apply(ctx) {
    (global as any).__cordis_ctx = ctx;
    if (process.argv.includes('--client')) {
        await applyClient(ctx);
    } else if (process.argv.includes('--node')) {
        applyNode(ctx);
    } else if (process.argv.includes('--projection')) {
        // Projection 模式：启动 WebService + DBService + projection handler
        await applyProjection(ctx);
    } else if (process.argv.includes('--proxy')) {
        // Proxy 模式：只启动服务器，不加载其他服务
        ctx.plugin(DBService);
        ctx.inject(['dbservice'], (c) => {
            applyServer(c);
        });
    } else if (process.argv.includes('--provider')) {
        // Provider 模式：启动 MCP Provider 服务器
        ctx.plugin(DBService);
        ctx.inject(['dbservice'], (c) => {
            applyProvider(c);
        });
    } else {
        ctx.plugin(DBService);
        ctx.inject(['dbservice'], (c) => {
            applyServer(c);
        });
    }
    logger.success('Tools started');
    process.send?.('ready');
    await ctx.parallel('app/ready');
}

app.plugin(TimerService);
app.plugin(LoggerService, {
    console: {
        showDiff: false,
        showTime: 'dd hh:mm:ss',
        label: {
            align: 'right',
            width: 9,
            margin: 1,
        },
        levels: { default: process.env.DEV ? 3 : 2 },
    },
});

if (config) app.inject(['logger', 'timer'], (ctx) => apply(ctx));
