import path from 'node:path';
import Schema from 'schemastery';
import { version as packageVersion } from './package.json';
import {
    checkReceiptPrinter,
    fs, getPrinters, Logger, randomstring, yaml,
} from './utils';

const logger = new Logger('init');

logger.info('Loading config');
const isClient = process.argv.includes('--client');
const configPath = path.resolve(process.cwd(), `config.${isClient ? 'client' : 'server'}.yaml`);
fs.ensureDirSync(path.resolve(process.cwd(), 'data'));

// eslint-disable-next-line import/no-mutable-exports
export let exit: Promise<void> | null = null;

if (!fs.existsSync(configPath)) {
    // eslint-disable-next-line no-promise-executor-return
    exit = new Promise((resolve) => (async () => {
        const serverConfigDefault = `\
# 仅需填写 host，其它保持注释既可
host: '' # 例如 edge.example.com:5283 或 10.0.0.5:5283

# 下面是可选项，暂不需要使用，保留注释
# type: server # server | domjudge | ejunz
# port: 5283
# xhost: x-forwarded-host
# viewPass: ${randomstring(8)} # use admin / viewPass to login
# secretRoute: ${randomstring(12)}
# seatFile: /home/icpc/Desktop/seats.txt
# customKeyfile: 
# edgeUpstream: '' # e.g. ws://host:port/edge/conn
# server: 
# token: 
# username: 
# password: 
# monitor:
#   timeSync: false
`;
        let printers = [];
        if (isClient) {
            printers = (await getPrinters().catch(() => [])).map((p: any) => p.printer);
            logger.info(printers.length, 'printers found:', JSON.stringify(printers));
            await checkReceiptPrinter(await getPrinters(true));
        }
        const clientConfigDefault = yaml.dump({
            server: '',
            token: '',
            balloon: '',
            balloonLang: 'zh',
            balloonType: 80,
            printColor: false,
            printers,
        });
        fs.writeFileSync(configPath, isClient ? clientConfigDefault : serverConfigDefault);
        logger.error('Config file generated, please fill in the config.yaml');
        resolve();
    })());
    throw new Error('no-config');
}

const serverSchema = Schema.object({
    // 为最简配置而精简，仅保留 host 与必要默认项
    host: Schema.string().default(''),
    edgeUpstream: Schema.string().default(''),
    // 保留以下默认项以兼容日志与现有代码（无需在配置中填写）
    port: Schema.number().default(5283),
    xhost: Schema.string().default('x-forwarded-host'),
    viewPass: Schema.string().default(randomstring(8)),
    secretRoute: Schema.string().default(randomstring(12)),
    seatFile: Schema.string().default('/home/icpc/Desktop/seat.txt'),
    customKeyfile: Schema.string().default(''),
    monitor: Schema.object({
        timeSync: Schema.boolean().default(false),
    }).default({ timeSync: false }),
}).description('Basic Config');
const clientSchema = Schema.object({
    server: Schema.transform(String, (i) => (i.endsWith('/') ? i : `${i}/`)).role('url').required(),
    balloon: Schema.string(),
    balloonLang: Schema.union(['zh', 'en']).default('zh').required(),
    balloonType: Schema.union([58, 80, 'plain']).default(80),
    balloonCommand: Schema.string().default(''),
    printColor: Schema.boolean().default(false),
    printPageMax: Schema.number().default(5),
    printMergeQueue: Schema.number().default(1),
    printers: Schema.array(Schema.string()).default([]).description('printer id list, will disable printing if unset'),
    token: Schema.string().required().description('Token generated on server'),
    fonts: Schema.array(Schema.string()).default([]),
});

export const config = (isClient ? clientSchema : serverSchema)(yaml.load(fs.readFileSync(configPath, 'utf8')) as any);
export const saveConfig = () => {
    fs.writeFileSync(configPath, yaml.dump(config));
};
export const version = packageVersion;

logger.info(`Config loaded from ${configPath}`);
logger.info(`agent-edge version: ${packageVersion}`);
if (!isClient && !exit) logger.info(`Server View User Info: admin / ${config.viewPass}`);
