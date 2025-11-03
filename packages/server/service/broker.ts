// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';

export default class BrokerService extends Service<Context> {
    private readonly logger = new Logger('broker');
    private aedes?: any;
    private server?: import('net').Server;

    async [Service.init](): Promise<void> {
        const nodeMode = process.argv.includes('--node');
        const brokerConf = (config as any).broker || {};
        const enabled = nodeMode ? (brokerConf.enabled ?? true) : (brokerConf.enabled ?? false);
        if (!enabled) return;
        let aedes: any;
        try { aedes = require('aedes')(); } catch (e) {
            this.logger.error('缺少依赖 aedes，请先安装：yarn add -W aedes');
            return;
        }
        const net = require('node:net');
        const port = brokerConf.port || 1883;
        this.aedes = aedes;
        this.server = net.createServer(aedes.handle);
        this.server.listen(port, '0.0.0.0', () => this.logger.success(`MQTT Broker started at 0.0.0.0:${port}`));
        aedes.on('client', (c: any) => this.logger.info(`client connected: ${c?.id || ''}`));
        aedes.on('clientDisconnect', (c: any) => this.logger.info(`client disconnected: ${c?.id || ''}`));
        aedes.on('publish', (p: any, c: any) => {
            if (p?.topic?.startsWith('$SYS')) return;
            this.logger.debug?.('publish %s bytes=%s by=%s', p?.topic, p?.payload?.length || 0, c?.id || '-');
        });
    }

    async [Service.dispose](): Promise<void> {
        try { await new Promise((r) => this.server?.close(() => r(null))); } catch {}
        try { this.aedes?.close?.(); } catch {}
        this.server = undefined;
        this.aedes = undefined;
    }
}


