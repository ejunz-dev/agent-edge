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
        ctx.plugin(require('./ejunz')),
    ]);
        await ctx.inject(['server', 'dbservice', 'voice'], async (c) => {
        await Promise.all([
            c.plugin(require('./handler/misc')),
            c.plugin(require('./handler/mcp')),
            c.plugin(require('./handler/edge')),
            c.plugin(require('./handler/client')),
            c.plugin(require('./handler/asr-proxy')),
                c.plugin(require('./handler/zigbee2mqtt')),
            c.plugin(require('./handler/audio-player')),
            c.plugin(require('./handler/audio-cache')),
            c.plugin(require('./handler/node')),
        ]);
        c.server.listen();
    });
}

function applyClient(ctx: Context) {
    ctx.plugin(require('./client/client'));
    // 启动自动语音交互
    ctx.plugin(require('./client/voice-auto'));
    // 启动音频播放器服务器（client 模式专用）
    ctx.plugin(require('./client/audio-player-server'));
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
        c.plugin(require('./handler/zigbee2mqtt'));
        c.plugin(require('./handler/mqtt-bridge-config'));
        c.plugin(require('./handler/node-ui'));
        c.plugin(require('./handler/zigbee-console')); // 最后注册，避免路由冲突
        c.server.listen();
    });
    // node client（仅用于本地 MQTT Broker 连接）
    // 上游 WebSocket 连接已移除，远程 MQTT 连接通过 mqttBridge 配置管理
    ctx.plugin(require('./client/node'));
}

async function apply(ctx) {
    (global as any).__cordis_ctx = ctx;
    if (process.argv.includes('--client')) {
        applyClient(ctx);
    } else if (process.argv.includes('--node')) {
        applyNode(ctx);
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
