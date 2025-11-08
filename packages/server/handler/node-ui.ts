// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import path from 'node:path';
import { fs, randomstring } from '../utils';

const randomHash = randomstring(8).toLowerCase();

// 提供Node UI的HTML页面
class NodeUIHomeHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        const context = {
            secretRoute: '',
            contest: { id: 'node-mode', name: 'Node Dashboard' },
        };
        if (this.request.headers.accept === 'application/json') {
            this.response.body = context;
        } else {
            this.response.type = 'text/html';
            // 检查是否是开发模式（通过检查是否有 webpack-dev-server 运行）
            // 在开发模式下，webpack-dev-server 在 8081 端口，直接提供 main.js
            // 在生产模式下，从 /node-ui/main.js 加载
            const isDev = process.env.NODE_ENV === 'development' || process.env.DEV === 'true';
            const scriptPath = isDev ? '/main.js' : `/node-ui/main.js?${randomHash}`;
            const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Node Dashboard - @Ejunz/agent-edge</title></head><body><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script src="${scriptPath}"></script></body></html>`;
            this.response.body = html;
        }
    }
}

// 提供Node UI的静态JS bundle
class NodeUIStaticHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        this.response.addHeader('Cache-Control', 'public');
        this.response.addHeader('Expires', new Date(new Date().getTime() + 86400000).toUTCString());
        this.response.type = 'text/javascript';
        // Serve built frontend bundle if available, otherwise fallback
        try {
            const bundlePath = path.resolve(__dirname, '../data/static.node-ui');
            if (fs.existsSync(bundlePath)) {
                this.response.body = fs.readFileSync(bundlePath, 'utf-8');
            } else {
                this.response.body = 'console.log("Node UI bundle not found. Please run `yarn build:ui` in packages/server/node/ui.")';
            }
        } catch (e) {
            this.response.body = 'console.log("Failed to load Node UI bundle.")';
        }
    }
}

export async function apply(ctx: Context) {
    // 只在node模式下注册
    if (process.argv.includes('--node')) {
        ctx.Route('node-ui-home', '/node-ui', NodeUIHomeHandler);
        ctx.Route('node-ui-static', '/node-ui/main.js', NodeUIStaticHandler);
        // 也支持根路径重定向到node-ui
        ctx.Route('node-ui-root', '/', NodeUIHomeHandler);
    }
}

