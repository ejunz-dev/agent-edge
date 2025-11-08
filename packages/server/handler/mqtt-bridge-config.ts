// @ts-nocheck
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from 'cordis';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { config, saveConfig } from '../config';
import MqttBridgeService from '../service/mqtt-bridge';

// 获取配置Schema信息（声明的配置）
class ConfigSchemaHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    async get() {
        // 定义schema信息（与config.ts中的定义保持一致）
        const schemaInfo = {
            enabled: { type: 'boolean', default: true, description: '是否启用MQTT桥接' },
            reconnect: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', default: true, description: '是否启用自动重连' },
                    period: { type: 'number', default: 5000, description: '重连间隔（毫秒）' },
                },
                description: '全局重连配置',
            },
            brokers: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', required: true, description: 'Broker名称' },
                        mqttUrl: { type: 'string', required: true, description: 'MQTT连接地址' },
                        baseTopic: { type: 'string', default: 'zigbee2mqtt', description: '基础主题' },
                        username: { type: 'string', default: '', description: '用户名' },
                        password: { type: 'string', default: '', description: '密码' },
                        enabled: { type: 'boolean', default: true, description: '是否启用此Broker' },
                        reconnect: {
                            type: 'object',
                            properties: {
                                enabled: { type: 'boolean', default: true, description: '是否启用自动重连（继承全局配置）' },
                                period: { type: 'number', default: 5000, description: '重连间隔（毫秒，继承全局配置）' },
                            },
                            description: 'Broker级别重连配置',
                        },
                    },
                },
                description: 'Broker列表',
            },
        };
        
        this.response.body = { schema: schemaInfo };
    }
}

// 获取/更新配置（合并到一个 handler，支持 GET 和 POST）
class ConfigHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    async get() {
        const bridgeConf = (config as any).mqttBridge || {};
        this.response.body = { config: bridgeConf };
    }
    async post() {
        try {
            const newConfig = this.request.body;
            if (!newConfig || typeof newConfig !== 'object') {
                this.response.status = 400;
                this.response.body = { error: '无效的配置数据' };
                return;
            }
            
            // 更新配置
            (config as any).mqttBridge = {
                ...((config as any).mqttBridge || {}),
                ...newConfig,
            };
            
            // 保存到文件
            saveConfig();
            
            this.response.body = { success: true, config: (config as any).mqttBridge };
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

// 重新加载配置（支持传入新配置，先保存再重载）
class ConfigReloadHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    async post() {
        try {
            // 如果请求体中有配置，先更新并保存
            if (this.request.body && typeof this.request.body === 'object') {
                const newConfig = this.request.body;
                // 更新配置
                (config as any).mqttBridge = {
                    ...((config as any).mqttBridge || {}),
                    ...newConfig,
                };
                // 保存到文件
                saveConfig();
            }
            
            // 然后重新加载配置
            await this.ctx.inject(['mqttBridge'], async (c) => {
                const svc = c.mqttBridge as MqttBridgeService;
                if (svc && typeof svc.reloadConfig === 'function') {
                    await svc.reloadConfig();
                    this.response.body = { success: true, message: '配置已保存并重新加载' };
                } else {
                    this.response.status = 500;
                    this.response.body = { error: 'MQTT Bridge 服务未初始化' };
                }
            });
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

// 获取配置状态（包括连接状态）
class ConfigStatusHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    async get() {
        try {
            await this.ctx.inject(['mqttBridge'], async (c) => {
                const svc = c.mqttBridge as MqttBridgeService;
                if (svc && typeof svc.getConfigStatus === 'function') {
                    const status = svc.getConfigStatus();
                    this.response.body = { success: true, status };
                } else {
                    this.response.status = 500;
                    this.response.body = { error: 'MQTT Bridge 服务未初始化' };
                }
            });
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

// 前端页面 Handler
class MqttBridgeConfigPage extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        const htmlPath = path.join(__dirname, '../node/mqtt-bridge-config.html');
        if (fs.existsSync(htmlPath)) {
            this.response.type = 'text/html; charset=utf-8';
            this.response.addHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
            this.response.addHeader('Pragma', 'no-cache');
            this.response.addHeader('Expires', '0');
            const content = fs.readFileSync(htmlPath, 'utf8');
            this.response.body = content;
        } else {
            this.response.status = 404;
            this.response.body = 'mqtt-bridge-config.html not found';
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('mqtt-bridge-config-page', '/mqtt-bridge-config', MqttBridgeConfigPage);
    ctx.Route('mqtt-bridge-config-schema', '/api/mqtt-bridge-config/schema', ConfigSchemaHandler);
    ctx.Route('mqtt-bridge-config', '/api/mqtt-bridge-config', ConfigHandler);
    ctx.Route('mqtt-bridge-config-reload', '/api/mqtt-bridge-config/reload', ConfigReloadHandler);
    ctx.Route('mqtt-bridge-config-status', '/api/mqtt-bridge-config/status', ConfigStatusHandler);
}

