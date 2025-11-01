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
            c.plugin(require('./handler/audio-player')),
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

async function apply(ctx) {
    (global as any).__cordis_ctx = ctx;
    if (process.argv.includes('--client')) {
        applyClient(ctx);
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
