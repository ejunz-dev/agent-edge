import { ConnectionHandler, Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';

const logger = new Logger('handler/edgeBridge');

class EdgeBridgeAliveHandler extends Handler<Context> {
    async get() {
        this.response.body = { ok: 1 };
    }
}

export class EdgeBridgeConnectionHandler extends ConnectionHandler<Context> {
    private upstream?: import('ws');
    private upstreamUrl = '';

    async prepare() {
        // 决定上游地址：优先 query.target，然后 ENV EDGE_UPSTREAM
        const normalizeFromHost = (host: string) => {
            if (!host) return '';
            if (/^https?:\/\//i.test(host)) {
                const base = host.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
                return new URL(base.endsWith('/') ? 'edge/conn' : '/edge/conn', base).toString();
            }
            if (/^wss?:\/\//i.test(host)) {
                return new URL(host.endsWith('/') ? 'edge/conn' : '/edge/conn', host).toString();
            }
            return `wss://${host}/edge/conn`;
        };
        const fromHost = normalizeFromHost((config as any).host || '');
        const target = (this.request.query?.target as string)
            || (config as any).edgeUpstream
            || fromHost
            || process.env.EDGE_UPSTREAM
            || '';
        if (!target) {
            this.send({ error: 'missing upstream url: provide ?target=ws://host:port/edge/conn or set EDGE_UPSTREAM' });
            this.close?.(1000, 'edge-bridge: missing upstream');
            return;
        }
        this.upstreamUrl = target;
        let WS: any;
        try {
            // 延迟引入，避免在未使用时加载
            // eslint-disable-next-line global-require, import/no-extraneous-dependencies
            WS = require('ws');
        } catch (e) {
            logger.error('ws module not found, please add dependency "ws"');
            this.send({ error: 'server missing ws dependency' });
            this.close?.(1011, 'edge-bridge: ws module missing');
            return;
        }
        const upstream = new WS(this.upstreamUrl);
        this.upstream = upstream;

        upstream.on('open', () => {
            logger.info('connected to upstream %s', this.upstreamUrl);
            // 握手：可选发送 ping 以测试
            try { this.send({ ok: 1, upstream: this.upstreamUrl }); } catch { /* ignore */ }
        });

        upstream.on('message', (data: any) => {
            try {
                const text = typeof data === 'string' ? data : data.toString('utf8');
                let payload: any = text;
                try { payload = JSON.parse(text); } catch { /* passthrough */ }
                this.send(payload);
            } catch { /* ignore */ }
        });

        upstream.on('close', (code: number, reason: Buffer) => {
            logger.info('upstream closed (%s): %s', code, reason?.toString?.() || '');
            try { this.send({ closed: true, code, reason: reason?.toString?.() || '' }); } catch { /* ignore */ }
            try { this.close?.(1000, 'edge-bridge: upstream closed'); } catch { /* ignore */ }
        });

        upstream.on('error', (err: Error) => {
            logger.warn('upstream error: %s', err.message);
            try { this.send({ error: err.message }); } catch { /* ignore */ }
        });
    }

    async message(msg: any) {
        if (!this.upstream || this.upstream.readyState !== (this.upstream as any).OPEN) return;
        try {
            const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
            (this.upstream as any).send(data);
        } catch (e) {
            logger.warn('forward message failed: %s', (e as Error).message);
        }
    }

    async cleanup() {
        if (this.upstream) {
            try { (this.upstream as any).close(); } catch { /* ignore */ }
            this.upstream = undefined;
        }
        logger.info('client disconnected (bridge)');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('edge_bridge_alive', '/edge-bridge', EdgeBridgeAliveHandler);
    ctx.Connection('edge_bridge_conn', '/edge-bridge/conn', EdgeBridgeConnectionHandler);
}


