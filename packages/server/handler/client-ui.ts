// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import path from 'node:path';
import { fs, randomstring } from '../utils';
import { config, saveConfig } from '../config';

const randomHash = randomstring(8).toLowerCase();

// 提供Client UI的HTML页面
class ClientUIHomeHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        const context = {
            secretRoute: '',
            contest: { id: 'client-mode', name: 'Client Dashboard' },
        };
        if (this.request.headers.accept === 'application/json') {
            this.response.body = context;
        } else {
            this.response.type = 'text/html';
            // 在生产模式下，从 /client-ui/main.js 加载
            // 检查构建文件是否存在，如果不存在则提示需要构建
            const bundlePath = path.resolve(__dirname, '../data/static.client-ui');
            const hasBundle = fs.existsSync(bundlePath);
            const scriptPath = hasBundle ? `/client-ui/main.js?${randomHash}` : '/main.js';
            const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Client Dashboard - @Ejunz/agent-edge</title></head><body><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script src="${scriptPath}"></script></body></html>`;
            this.response.body = html;
        }
    }
}

// 提供Client UI的静态JS bundle
class ClientUIStaticHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        this.response.addHeader('Cache-Control', 'public');
        this.response.addHeader('Expires', new Date(new Date().getTime() + 86400000).toUTCString());
        this.response.type = 'text/javascript';
        // Serve built frontend bundle if available, otherwise fallback
        try {
            const bundlePath = path.resolve(__dirname, '../data/static.client-ui');
            if (fs.existsSync(bundlePath)) {
                this.response.body = fs.readFileSync(bundlePath, 'utf-8');
            } else {
                this.response.body = 'console.log("Client UI bundle not found. Please run `yarn build:ui` in packages/server/client/ui.")';
            }
        } catch (e) {
            this.response.body = 'console.log("Failed to load Client UI bundle.")';
        }
    }
}

// 客户端配置 API
class ClientConfigHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    
    async get() {
        try {
            // 从内存中的 config 对象读取
            const voiceConfig = (config as any).voice || {};
            const vtuberConfig = voiceConfig.vtuber || {};
            const vtsConfig = vtuberConfig.vtubestudio || {};
            
            const clientConfig = {
                server: (config as any).server || '',
                port: (config as any).port || 5283,
                vtuber: {
                    enabled: vtuberConfig.enabled !== false,
                    vtubestudio: {
                        host: vtsConfig.host || '127.0.0.1',
                        port: vtsConfig.port || 8001,
                        enabled: vtuberConfig.enabled !== false && vtuberConfig.engine === 'vtubestudio',
                    },
                },
            };
            
            this.response.type = 'application/json';
            this.response.body = { config: clientConfig };
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
    
    async post() {
        try {
            const newConfig = this.request.body;
            
            if (!newConfig || typeof newConfig !== 'object') {
                this.response.status = 400;
                this.response.body = { error: '无效的配置数据' };
                return;
            }
            
            // 更新内存中的 config 对象
            if (typeof newConfig.server === 'string') {
                (config as any).server = newConfig.server;
            }
            if (typeof newConfig.port === 'number') {
                (config as any).port = newConfig.port;
            }
            
            // 更新 VTube Studio 配置
            if (newConfig.vtuber) {
                if (!(config as any).voice) (config as any).voice = {};
                if (!(config as any).voice.vtuber) (config as any).voice.vtuber = {};
                
                const vtuber = (config as any).voice.vtuber;
                if (typeof newConfig.vtuber.enabled === 'boolean') {
                    vtuber.enabled = newConfig.vtuber.enabled;
                }
                
                if (newConfig.vtuber.vtubestudio) {
                    if (!vtuber.vtubestudio) vtuber.vtubestudio = {};
                    const vts = vtuber.vtubestudio;
                    if (typeof newConfig.vtuber.vtubestudio.host === 'string') {
                        vts.host = newConfig.vtuber.vtubestudio.host;
                    }
                    if (typeof newConfig.vtuber.vtubestudio.port === 'number') {
                        vts.port = newConfig.vtuber.vtubestudio.port;
                    }
                    // vtubestudio.enabled 只用于控制是否使用 vtubestudio 引擎
                    // 不影响 vtuber.enabled（主开关）
                    if (typeof newConfig.vtuber.vtubestudio.enabled === 'boolean') {
                        if (newConfig.vtuber.vtubestudio.enabled) {
                            vtuber.engine = 'vtubestudio';
                        } else if (vtuber.engine === 'vtubestudio') {
                            // 如果关闭 vtubestudio，且当前引擎是 vtubestudio，则禁用整个 vtuber
                            vtuber.enabled = false;
                        }
                    }
                }
            }
            
            // 保存到文件
            saveConfig();
            
            this.response.type = 'application/json';
            this.response.body = { success: true, config: {
                server: (config as any).server,
                port: (config as any).port,
                vtuber: (config as any).voice?.vtuber || {},
            } };
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

// 重新加载配置（重新连接上游服务器）
class ClientConfigReloadHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    
    async post() {
        try {
            // 如果请求体中有配置，先更新并保存
            if (this.request.body && typeof this.request.body === 'object') {
                const newConfig = this.request.body;
                if (typeof newConfig.server === 'string') {
                    (config as any).server = newConfig.server;
                }
                if (typeof newConfig.port === 'number') {
                    (config as any).port = newConfig.port;
                }
                
                // 更新 VTube Studio 配置
                if (newConfig.vtuber) {
                    if (!(config as any).voice) (config as any).voice = {};
                    if (!(config as any).voice.vtuber) (config as any).voice.vtuber = {};
                    
                    const vtuber = (config as any).voice.vtuber;
                    if (typeof newConfig.vtuber.enabled === 'boolean') {
                        vtuber.enabled = newConfig.vtuber.enabled;
                    }
                    
                    if (newConfig.vtuber.vtubestudio) {
                        if (!vtuber.vtubestudio) vtuber.vtubestudio = {};
                        const vts = vtuber.vtubestudio;
                        if (typeof newConfig.vtuber.vtubestudio.host === 'string') {
                            vts.host = newConfig.vtuber.vtubestudio.host;
                        }
                        if (typeof newConfig.vtuber.vtubestudio.port === 'number') {
                            vts.port = newConfig.vtuber.vtubestudio.port;
                        }
                        // vtubestudio.enabled 只用于控制是否使用 vtubestudio 引擎
                        // 不影响 vtuber.enabled（主开关）
                        if (typeof newConfig.vtuber.vtubestudio.enabled === 'boolean') {
                            if (newConfig.vtuber.vtubestudio.enabled) {
                                vtuber.engine = 'vtubestudio';
                            } else if (vtuber.engine === 'vtubestudio') {
                                // 如果关闭 vtubestudio，且当前引擎是 vtubestudio，则禁用整个 vtuber
                                vtuber.enabled = false;
                            }
                        }
                    }
                }
                
                // 保存到文件
                saveConfig();
            }
            
            // 通过 Service 重新加载配置
            await this.ctx.inject(['client'], async (c) => {
                const svc = c.client;
                if (svc && typeof svc.reloadConfig === 'function') {
                    await svc.reloadConfig();
                    this.response.type = 'application/json';
                    this.response.body = { success: true, message: '配置已保存并重新加载' };
                } else {
                    this.response.status = 500;
                    this.response.body = { error: 'Client 服务未初始化' };
                }
            });
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export async function apply(ctx: Context) {
    // 只在client模式下注册（通过检查是否有 --client 参数或配置文件）
    const isClientMode = process.argv.includes('--client') || 
                         (process.env.CLIENT_MODE === 'true') ||
                         fs.existsSync(path.resolve(__dirname, '../../config.client.yaml'));
    
    if (isClientMode) {
        ctx.Route('client-ui-home', '/client-ui', ClientUIHomeHandler);
        ctx.Route('client-ui-static', '/client-ui/main.js', ClientUIStaticHandler);
        ctx.Route('client-config', '/api/client-config', ClientConfigHandler);
        ctx.Route('client-config-reload', '/api/client-config/reload', ClientConfigReloadHandler);
    }
}

