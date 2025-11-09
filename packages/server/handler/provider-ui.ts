// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import path from 'node:path';
import { fs, randomstring } from '../utils';

const randomHash = randomstring(8).toLowerCase();

// 提供Provider UI的HTML页面
class ProviderUIHomeHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        const context = {
            secretRoute: '',
            contest: { id: 'provider-mode', name: 'MCP Provider Dashboard' },
        };
        if (this.request.headers.accept === 'application/json') {
            this.response.body = context;
        } else {
            this.response.type = 'text/html';
            // 在生产模式下，从 /provider-ui/main.js 加载
            // 检查构建文件是否存在，如果不存在则提示需要构建
            const bundlePath = path.resolve(__dirname, '../data/static.provider-ui');
            const hasBundle = fs.existsSync(bundlePath);
            const scriptPath = hasBundle ? `/provider-ui/main.js?${randomHash}` : '/main.js';
            const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP Provider Dashboard - @Ejunz/agent-edge</title></head><body><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script src="${scriptPath}"></script></body></html>`;
            this.response.body = html;
        }
    }
}

// 提供Provider UI的静态JS bundle
class ProviderUIStaticHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        this.response.addHeader('Cache-Control', 'public');
        this.response.addHeader('Expires', new Date(new Date().getTime() + 86400000).toUTCString());
        this.response.type = 'text/javascript';
        // Serve built frontend bundle if available, otherwise fallback
        try {
            const bundlePath = path.resolve(__dirname, '../data/static.provider-ui');
            if (fs.existsSync(bundlePath)) {
                this.response.body = fs.readFileSync(bundlePath, 'utf-8');
            } else {
                this.response.body = 'console.log("Provider UI bundle not found. Please run `yarn build:ui` in packages/provider-ui.")';
            }
        } catch (e) {
            this.response.body = 'console.log("Failed to load Provider UI bundle.")';
        }
    }
}

export async function apply(ctx: Context) {
    // 只在provider模式下注册
    if (process.argv.includes('--provider')) {
        ctx.Route('provider-ui-home', '/provider-ui', ProviderUIHomeHandler);
        ctx.Route('provider-ui-static', '/provider-ui/main.js', ProviderUIStaticHandler);
        // 也支持根路径重定向到provider-ui
        ctx.Route('provider-ui-root', '/', ProviderUIHomeHandler);
    }
}

