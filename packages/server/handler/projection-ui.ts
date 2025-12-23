// @ts-nocheck
import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import path from 'node:path';
import { fs, randomstring, Logger } from '../utils';
import { config } from '../config';

const logger = new Logger('projection-ui');
const randomHash = randomstring(8).toLowerCase();

// 当前最新的 CS2 GSI 状态（进程内内存存储）
let latestCs2State: any = null;
let latestCs2UpdateAt: number | null = null;

// 维护所有前端 WebSocket 连接，用于推送实时数据
const projectionConnections = new Set<ConnectionHandler<Context>>();

function broadcastState() {
  if (!latestCs2State) return;
  const payload = {
    type: 'state',
    data: latestCs2State,
    ts: Date.now(),
  };
  for (const conn of projectionConnections) {
    try {
      conn.send(payload);
    } catch (e) {
      logger.debug('向前端推送状态失败: %s', (e as Error).message);
    }
  }
}

// 提供 Projection UI 的 HTML 页面（给 OBS 加载）
class ProjectionUIHomeHandler extends Handler<Context> {
  noCheckPermView = true;
  async get() {
    const context = {
      secretRoute: '',
      contest: { id: 'projection', name: 'CS2 Projection Overlay' },
    };

    if (this.request.headers.accept === 'application/json') {
      this.response.body = context;
    } else {
      this.response.type = 'text/html';
      const bundlePath = path.resolve(__dirname, '../data/static.projection-ui');
      const hasBundle = fs.existsSync(bundlePath);
      const scriptPath = hasBundle ? `/projection-ui/main.js?${randomHash}` : '/main.js';
      const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CS2 Projection Overlay - @Ejunz/agent-edge</title></head><body style="margin:0;background:transparent;"><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script src="${scriptPath}"></script></body></html>`;
      this.response.body = html;
    }
  }
}

// 提供 Projection UI 的静态 JS bundle
class ProjectionUIStaticHandler extends Handler<Context> {
  noCheckPermView = true;
  async get() {
    this.response.addHeader('Cache-Control', 'public');
    this.response.addHeader('Expires', new Date(new Date().getTime() + 86400000).toUTCString());
    this.response.type = 'text/javascript';
    try {
      const bundlePath = path.resolve(__dirname, '../data/static.projection-ui');
      if (fs.existsSync(bundlePath)) {
        this.response.body = fs.readFileSync(bundlePath, 'utf-8');
      } else {
        this.response.body = 'console.log("Projection UI bundle not found. Please run `yarn build:ui` in packages/server/projection/ui.")';
      }
    } catch (e) {
      this.response.body = 'console.log("Failed to load Projection UI bundle.")';
    }
  }
}

// 提供当前最新的 CS2 状态（REST 轮询接口，备用）
class ProjectionStateHandler extends Handler<Context> {
  noCheckPermView = true;
  allowCors = true;

  async get() {
    this.response.type = 'application/json';
    this.response.body = {
      ok: true,
      ts: Date.now(),
      state: latestCs2State,
      lastUpdateAt: latestCs2UpdateAt,
    };
  }
}

// 基本信息 / 健康检查（类似 node/client 的 dashboard 数据源）
class ProjectionInfoHandler extends Handler<Context> {
  noCheckPermView = true;
  allowCors = true;

  async get() {
    const now = new Date();
    this.response.type = 'application/json';
    this.response.body = {
      ok: true,
      mode: 'projection',
      time: now.toISOString(),
      timestamp: now.getTime(),
      port: (config as any).port || 5283,
      gsi: {
        lastUpdateAt: latestCs2UpdateAt,
        isActive: typeof latestCs2UpdateAt === 'number'
          ? (now.getTime() - latestCs2UpdateAt) < 5000
          : false,
      },
    };
  }
}

// 接收 CS2 Game State Integration POST 的数据
// 建议在 CS2 配置中把 endpoint 指向 http://127.0.0.1:5283/api/projection/cs2-gsi
class ProjectionCs2GSIHandler extends Handler<Context> {
  noCheckPermView = true;
  allowCors = true;

  async post() {
    try {
      const body = this.request.body;
      latestCs2State = body || {};
      latestCs2UpdateAt = Date.now();
      this.response.type = 'application/json';
      this.response.body = { ok: true };

      // 日志简单标记一下回合 / 玩家信息，方便调试
      const roundPhase = body?.round?.phase;
      const playerName = body?.player?.name;
      logger.debug('收到 CS2 GSI 更新: roundPhase=%s, player=%s', roundPhase, playerName);

      // 调试日志：打印关键字段（注意长度控制，避免刷屏）
      try {
        const debugPayload = {
          round: body?.round,
          bomb: body?.bomb,
          player: {
            name: body?.player?.name,
            team: body?.player?.team,
          },
        };
        logger.debug('CS2 GSI 关键字段: %s', JSON.stringify(debugPayload));
      } catch {}

      // 推送给所有前端连接
      broadcastState();
    } catch (e) {
      this.response.status = 500;
      this.response.body = { ok: false, error: (e as Error).message };
    }
  }
}

// 前端 Overlay WebSocket，用于实时推送 GSI 状态给浏览器（OBS 场景里加载）
class ProjectionWebSocketHandler extends ConnectionHandler<Context> {
  noCheckPermView = true;

  async prepare() {
    logger.debug('[projection-ws] 前端连接已建立');
    projectionConnections.add(this);

    // 刚连上时先推一次当前的最新状态
    if (latestCs2State) {
      try {
        this.send({
          type: 'state',
          data: latestCs2State,
          ts: Date.now(),
        });
      } catch (e) {
        logger.debug('[projection-ws] 初始状态推送失败: %s', (e as Error).message);
      }
    }
  }

  async message(msg: any) {
    // 目前前端无需发送任何指令，这里仅保留心跳占位
    if (typeof msg === 'string' && msg.trim() === 'ping') {
      try {
        this.send('pong');
      } catch (e) {
        logger.debug('[projection-ws] 发送心跳响应失败: %s', (e as Error).message);
      }
      return;
    }
  }

  async cleanup() {
    projectionConnections.delete(this);
    logger.debug('[projection-ws] 前端连接已断开，当前连接数: %d', projectionConnections.size);
  }
}

export async function apply(ctx: Context) {
  // 在默认 server 模式下注册（不区分 client / node / provider）
  ctx.Route('projection-ui-home', '/projection-ui', ProjectionUIHomeHandler);
  ctx.Route('projection-ui-static', '/projection-ui/main.js', ProjectionUIStaticHandler);
  ctx.Route('projection-state', '/api/projection/state', ProjectionStateHandler);
  ctx.Route('projection-info', '/api/projection/info', ProjectionInfoHandler);
  // CS2 GSI 入口，提供多个别名路径，方便在游戏里配置
  ctx.Route('projection-cs2-gsi', '/api/projection/cs2-gsi', ProjectionCs2GSIHandler);
  ctx.Route('projection-cs2-gsi-short', '/cs2-gsi', ProjectionCs2GSIHandler);
  ctx.Route('projection-cs2-gsi-alt', '/projection/cs2-gsi', ProjectionCs2GSIHandler);
  ctx.Connection('projection-ws', '/projection-ws', ProjectionWebSocketHandler);
}


