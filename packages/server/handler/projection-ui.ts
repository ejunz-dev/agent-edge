// @ts-nocheck
import { Context } from 'cordis';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import path from 'node:path';
import superagent from 'superagent';
import { fs, randomstring, Logger } from '../utils';
import { config } from '../config';
import { sendRoundInfo } from '../projection/client';

const logger = new Logger('projection-ui');
const randomHash = randomstring(8).toLowerCase();

// 当前最新的 CS2 GSI 状态（进程内内存存储）
let latestCs2State: any = null;
let latestCs2UpdateAt: number | null = null;
let lastRoundNumber: number | null = null;
let lastRoundPhase: string | null = null;

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
    logger.info('[ProjectionUI] ========== GET 请求开始 ==========');
    logger.info('[ProjectionUI] URL: %s', this.request.url);
    logger.info('[ProjectionUI] Path: %s', this.request.path);
    logger.info('[ProjectionUI] Method: %s', this.request.method);
    logger.info('[ProjectionUI] Headers: %o', this.request.headers);
    const context = {
      secretRoute: '',
      contest: { id: 'projection', name: 'CS2 Projection Overlay' },
    };

    // 从数据库加载所有 widget 配置（服务端渲染）
    let widgetConfigs: Record<string, any> = {};
    try {
      // 尝试从数据库加载配置
      const docs = await this.ctx.db.widgetConfig.find({});
      logger.info('[ProjectionUI] 数据库查询结果: %d 条记录', docs.length);
      for (const doc of docs) {
        widgetConfigs[doc.widgetName] = doc.config;
        logger.info('[ProjectionUI] 加载配置: %s', doc.widgetName);
      }
      logger.info('[ProjectionUI] 加载了 %d 个 widget 配置', Object.keys(widgetConfigs).length);
    } catch (e) {
      logger.error('[ProjectionUI] 加载 widget 配置失败: %s', (e as Error).message);
      logger.error('[ProjectionUI] 错误堆栈: %s', (e as Error).stack);
    }

    if (this.request.headers.accept === 'application/json') {
      this.response.body = { ...context, widgetConfigs };
    } else {
      this.response.type = 'text/html';
      // 禁用缓存，确保每次请求都获取最新配置
      this.response.addHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      this.response.addHeader('Pragma', 'no-cache');
      this.response.addHeader('Expires', '0');
      
      const bundlePath = path.resolve(__dirname, '../data/static.projection-ui');
      const hasBundle = fs.existsSync(bundlePath);
      const scriptPath = hasBundle ? `/main.js?${randomHash}` : '/main.js';
      // 将 widget 配置嵌入到 HTML 中，供前端使用
      const widgetConfigsScript = `window.__WIDGET_CONFIGS__=JSON.parse('${JSON.stringify(widgetConfigs).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}');`;
      const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CS2 Projection Overlay - @Ejunz/agent-edge</title></head><body style="margin:0;background:transparent;"><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script>${widgetConfigsScript}</script><script src="${scriptPath}"></script></body></html>`;
      this.response.body = html;
    }
  }
}

// 为每个 widget 创建专门的路由 handler 基类
class BaseWidgetHandler extends Handler<Context> {
  noCheckPermView = true;
  protected abstract getWidgetName(): string;

  async get() {
    const widgetName = this.getWidgetName();
    logger.info(`[${this.constructor.name}] ${widgetName} - GET 请求: %s`, this.request.url);
    const context = {
      secretRoute: '',
      contest: { id: 'projection', name: 'CS2 Projection Overlay' },
    };

    // 从数据库加载该 widget 的配置（服务端渲染）
    let widgetConfig: any = null;
    try {
      await this.ctx.inject(['dbservice'], async (ctx) => {
        const doc = await ctx.db.widgetConfig.findOne({ widgetName });
        if (doc) {
          widgetConfig = doc.config;
          logger.info(`[${this.constructor.name}] ${widgetName} - 加载配置成功`);
        } else {
          logger.info(`[${this.constructor.name}] ${widgetName} - 未找到配置，使用默认配置`);
        }
      });
    } catch (e) {
      logger.error(`[${this.constructor.name}] ${widgetName} - 加载配置失败: %s`, (e as Error).message);
    }

    if (this.request.headers.accept === 'application/json') {
      this.response.body = { ...context, widgetConfig: widgetConfig || {} };
    } else {
      this.response.type = 'text/html';
      // 禁用缓存，确保每次请求都获取最新配置
      this.response.addHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      this.response.addHeader('Pragma', 'no-cache');
      this.response.addHeader('Expires', '0');
      
      const bundlePath = path.resolve(__dirname, '../data/static.projection-ui');
      const hasBundle = fs.existsSync(bundlePath);
      const scriptPath = hasBundle ? `/main.js?${randomHash}` : '/main.js';
      // 将 widget 配置嵌入到 HTML 中，供前端使用
      const widgetConfigScript = widgetConfig 
        ? `window.__WIDGET_CONFIG__=JSON.parse('${JSON.stringify(widgetConfig).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}');`
        : `window.__WIDGET_CONFIG__=null;`;
      const html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${widgetName} - CS2 Projection Overlay</title></head><body style="margin:0;background:transparent;"><div id="root"></div><script>window.Context=JSON.parse('${JSON.stringify(context).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')</script><script>window.__WIDGET_NAME__='${widgetName}';</script><script>${widgetConfigScript}</script><script src="${scriptPath}"></script></body></html>`;
      this.response.body = html;
    }
  }
}

// 为每个 widget 创建独立的 handler 类
class WeaponsHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'weapons'; }
}

class PlayerHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'player'; }
}

class HealthHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'health'; }
}

class ArmorHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'armor'; }
}

class ScoreHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'score'; }
}

class BombHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'bomb'; }
}

class StatsHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'stats'; }
}

class RoundHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'round'; }
}

class FaceitHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'faceit'; }
}

class MatchTeamsHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'matchteams'; }
}

class MyTeamHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'myteam'; }
}

class EnemyTeamHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'enemyteam'; }
}

class AgentStreamHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'agentstream'; }
}

class EmojiHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'emoji'; }
}

class TTSHandler extends BaseWidgetHandler {
  protected getWidgetName() { return 'tts'; }
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

// 提供表情包图片文件
class ProjectionImageHandler extends Handler<Context> {
  noCheckPermView = true;
  async get() {
    const imageName = this.request.params.name as string;
    if (!imageName) {
      this.response.status = 404;
      this.response.body = { error: 'Image name required' };
      return;
    }

    // 安全检查：只允许 PNG 文件，防止路径遍历
    if (!imageName.endsWith('.png') || imageName.includes('..') || imageName.includes('/')) {
      this.response.status = 403;
      this.response.body = { error: 'Invalid image name' };
      return;
    }

    try {
      const imagePath = path.resolve(__dirname, '../projection/images', imageName);
      
      // 再次安全检查：确保文件在 images 目录内
      const imagesDir = path.resolve(__dirname, '../projection/images');
      if (!imagePath.startsWith(imagesDir)) {
        this.response.status = 403;
        this.response.body = { error: 'Invalid image path' };
        return;
      }

      if (fs.existsSync(imagePath)) {
        this.response.type = 'image/png';
        this.response.addHeader('Cache-Control', 'public, max-age=86400');
        this.response.body = fs.readFileSync(imagePath);
      } else {
        this.response.status = 404;
        this.response.body = { error: 'Image not found' };
      }
    } catch (e) {
      logger.error('加载表情包图片失败: %s', (e as Error).message);
      this.response.status = 500;
      this.response.body = { error: 'Failed to load image' };
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
      const currentRoundNumber = body?.round?.round ?? null;
      
      // 减少日志噪声：已注释掉频繁的 GSI 更新日志
      // logger.debug('收到 CS2 GSI 更新: roundPhase=%s, round=%s, player=%s', roundPhase, currentRoundNumber, playerName);

      // 检测回合结束：phase 变成 'over' 或 'gameover'，且回合数或阶段发生变化
      const isRoundEnd = (roundPhase === 'over' || roundPhase === 'gameover') &&
                         (currentRoundNumber !== lastRoundNumber || roundPhase !== lastRoundPhase);
      
      if (isRoundEnd) {
        logger.info('检测到回合结束: round=%s, phase=%s', currentRoundNumber, roundPhase);
        
        // 提取回合信息
        const round = body?.round || {};
        const player = body?.player || {};
        const playerState = player?.state || {};
        const playerStats = player?.match_stats || {};
        const map = body?.map || {};
        const allPlayers = body?.allplayers || {};
        
        // 构建完整的回合数据
        const roundData = {
          round: currentRoundNumber,
          phase: roundPhase,
          winner: round?.winner || null,
          player: {
            name: player?.name || null,
            team: player?.team || null,
            steamid: player?.steamid || null,
            state: {
              health: playerState?.health ?? 0,
              armor: playerState?.armor ?? 0,
              money: playerState?.money ?? 0,
              round_kills: playerState?.round_kills ?? 0,
              round_killhs: playerState?.round_killhs ?? 0,
              round_damage: playerState?.round_damage ?? 0,
              flashed: playerState?.flashed ?? 0,
              burning: playerState?.burning ?? 0,
            },
            // 添加玩家统计数据
            stats: {
              kills: playerStats?.kills ?? 0,
              assists: playerStats?.assists ?? 0,
              deaths: playerStats?.deaths ?? 0,
              mvps: playerStats?.mvps ?? 0,
              score: playerStats?.score ?? 0,
            },
            // 添加武器信息
            weapons: playerState?.weapons || {},
            // 添加位置信息（如果有）
            position: playerState?.position || null,
          },
          map: {
            name: map?.name || null,
            phase: map?.phase || null,
            round_wins: map?.round_wins || {},
            team_ct: {
              score: map?.team_ct?.score ?? 0,
              name: map?.team_ct?.name || 'CT',
            },
            team_t: {
              score: map?.team_t?.score ?? 0,
              name: map?.team_t?.name || 'T',
            },
          },
          // 添加所有玩家信息（用于分析团队表现）
          allplayers: allPlayers,
          timestamp: Date.now(),
        };
        
        // 发送回合信息到上游
        sendRoundInfo(roundData);
      }
      
      // 更新最后的状态
      if (currentRoundNumber !== null) {
        lastRoundNumber = currentRoundNumber;
      }
      if (roundPhase) {
        lastRoundPhase = roundPhase;
      }

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
        // 减少日志噪声：已注释掉频繁的 GSI 关键字段日志
        // logger.debug('CS2 GSI 关键字段: %s', JSON.stringify(debugPayload));
      } catch {}

      // 推送给所有前端连接
      broadcastState();
    } catch (e) {
      this.response.status = 500;
      this.response.body = { ok: false, error: (e as Error).message };
    }
  }
}

// Faceit API Handler - 获取当前对局信息（双方队伍）
class FaceitMatchHandler extends Handler<Context> {
  noCheckPermView = true;
  allowCors = true;

  async get() {
    const faceitConfig = (config as any).faceit || {};
    const apiKey = faceitConfig.apiKey || '';
    const playerId = faceitConfig.playerId || '';

    // 如果没有 Faceit API Key，尝试使用 CS2 GSI 数据作为备选
    if (!apiKey) {
      const cs2State = latestCs2State || {};
      const allPlayers = cs2State.allplayers || {};
      const map = cs2State.map || {};
      
      // 从 CS2 GSI 中提取所有玩家信息
      const cs2Team1: any[] = [];
      const cs2Team2: any[] = [];
      
      if (allPlayers && typeof allPlayers === 'object') {
        Object.values(allPlayers).forEach((p: any) => {
          if (!p || !p.name) return;
          const playerData = {
            id: p.steamid || p.name,
            nickname: p.name,
            avatar: null, // CS2 GSI 不提供头像
            country: null,
            elo: null, // CS2 GSI 不提供 ELO
            level: null,
            team: p.team || 'unknown',
          };
          
          if (p.team === 'CT' || p.team === 'ct') {
            cs2Team1.push(playerData);
          } else if (p.team === 'T' || p.team === 't') {
            cs2Team2.push(playerData);
          }
        });
      }
      
      // 如果 CS2 GSI 有数据，返回它
      if (cs2Team1.length > 0 || cs2Team2.length > 0) {
        this.response.type = 'application/json';
        this.response.body = {
          ok: true,
          match: {
            id: 'cs2-gsi',
            source: 'cs2-gsi',
            teams: {
              team1: {
                id: 'CT',
                name: map?.team_ct?.name || 'CT',
                players: cs2Team1,
              },
              team2: {
                id: 'T',
                name: map?.team_t?.name || 'T',
                players: cs2Team2,
              },
            },
          },
        };
        return;
      }
      
      this.response.status = 400;
      this.response.type = 'application/json';
      this.response.body = { ok: false, error: 'Faceit API Key 未配置，且 CS2 GSI 数据不可用' };
      return;
    }

    try {
      // 获取目标 Player ID（复用之前的逻辑）
      let targetPlayerId = playerId;
      
      if (!targetPlayerId) {
        const nickname = this.request.query.nickname as string || '';
        if (nickname) {
          try {
            const searchRes = await superagent
              .get('https://open.faceit.com/data/v4/players')
              .set('Authorization', `Bearer ${apiKey}`)
              .query({ nickname });
            if (searchRes.body?.player_id) {
              targetPlayerId = searchRes.body.player_id;
            }
          } catch (e) {
            logger.debug('通过用户名获取 Player ID 失败: %s', (e as Error).message);
          }
        }
        
        if (!targetPlayerId && latestCs2State?.player?.steamid) {
          try {
            const steamId = latestCs2State.player.steamid;
            const searchRes = await superagent
              .get('https://open.faceit.com/data/v4/players')
              .set('Authorization', `Bearer ${apiKey}`)
              .query({ game: 'cs2', game_player_id: steamId });
            if (searchRes.body?.player_id) {
              targetPlayerId = searchRes.body.player_id;
            }
          } catch (e) {
            logger.debug('通过 Steam ID 获取 Player ID 失败: %s', (e as Error).message);
          }
        }
      }

      if (!targetPlayerId) {
        this.response.status = 400;
        this.response.type = 'application/json';
        this.response.body = { ok: false, error: '未找到 Faceit Player ID' };
        return;
      }

      // 获取当前对局（正在进行的比赛）
      // 先获取最近比赛，检查是否有正在进行的
      const matchesRes = await superagent
        .get(`https://open.faceit.com/data/v4/players/${targetPlayerId}/history`)
        .set('Authorization', `Bearer ${apiKey}`)
        .query({ game: 'cs2', limit: 1 });

      const matches = matchesRes.body?.items || [];
      if (matches.length === 0) {
        this.response.type = 'application/json';
        this.response.body = { ok: true, match: null, message: '没有找到当前对局' };
        return;
      }

      const latestMatch = matches[0];
      
      // 检查比赛是否正在进行（finished_at 为 null 或未来时间）
      const now = Math.floor(Date.now() / 1000);
      const isOngoing = !latestMatch.finished_at || latestMatch.finished_at > now;

      if (!isOngoing) {
        // 如果没有正在进行的 Faceit 对局，尝试使用 CS2 GSI 数据并通过 Faceit API 搜索每个玩家
        const cs2State = latestCs2State || {};
        const allPlayers = cs2State.allplayers || {};
        const map = cs2State.map || {};
        
        // 从 CS2 GSI 中提取所有玩家信息，并尝试通过 Faceit API 获取详细信息
        const cs2Team1: any[] = [];
        const cs2Team2: any[] = [];
        
        // 通过 Faceit API 搜索玩家信息的函数
        const searchPlayerBySteamId = async (steamId: string): Promise<any | null> => {
          if (!steamId || !apiKey) return null;
          try {
            const searchRes = await superagent
              .get('https://open.faceit.com/data/v4/players')
              .set('Authorization', `Bearer ${apiKey}`)
              .query({ game: 'cs2', game_player_id: steamId });
            
            if (searchRes.body?.player_id) {
              const playerId = searchRes.body.player_id;
              // 获取玩家详细信息
              const playerRes = await superagent
                .get(`https://open.faceit.com/data/v4/players/${playerId}`)
                .set('Authorization', `Bearer ${apiKey}`);
              
              // 获取玩家统计数据
              let stats = {};
              try {
                const statsRes = await superagent
                  .get(`https://open.faceit.com/data/v4/players/${playerId}/stats/cs2`)
                  .set('Authorization', `Bearer ${apiKey}`);
                stats = statsRes.body?.lifetime || {};
              } catch (e) {
                logger.debug('获取玩家统计失败: %s', (e as Error).message);
              }
              
              return {
                id: playerRes.body.player_id,
                nickname: playerRes.body.nickname,
                avatar: playerRes.body.avatar,
                country: playerRes.body.country,
                elo: playerRes.body.games?.cs2?.faceit_elo || 0,
                level: playerRes.body.games?.cs2?.skill_level || 0,
                stats: {
                  winRate: stats['Win Rate %'] ? parseFloat(stats['Win Rate %']) : 0,
                  avg: stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0,
                  kd: stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0,
                  adr: stats['Average Damage per Round'] ? parseFloat(stats['Average Damage per Round']) : 0,
                  hsPercent: stats['Average Headshots %'] ? parseFloat(stats['Average Headshots %']) : 0,
                  totalKills: stats['Total Kills'] || 0,
                },
              };
            }
          } catch (e) {
            logger.debug('通过 Steam ID 搜索 Faceit 玩家失败: %s', (e as Error).message);
          }
          return null;
        };
        
        if (allPlayers && typeof allPlayers === 'object') {
          // 并行搜索所有玩家
          const playerPromises: Promise<any>[] = [];
          const playerMap = new Map<string, any>();
          
          Object.values(allPlayers).forEach((p: any) => {
            if (!p || !p.name) return;
            const steamId = p.steamid;
            const team = p.team;
            
            if (steamId) {
              const promise = searchPlayerBySteamId(steamId).then((faceitData) => {
                const playerData = {
                  id: faceitData?.id || steamId || p.name,
                  nickname: faceitData?.nickname || p.name,
                  avatar: faceitData?.avatar || null,
                  country: faceitData?.country || null,
                  elo: faceitData?.elo || null,
                  level: faceitData?.level || null,
                  stats: faceitData?.stats || {},
                  team: team || 'unknown',
                  steamid: steamId,
                };
                playerMap.set(steamId, { playerData, team });
              });
              playerPromises.push(promise);
            } else {
              // 没有 Steam ID，使用默认数据
              const playerData = {
                id: p.name,
                nickname: p.name,
                avatar: null,
                country: null,
                elo: null,
                level: null,
                stats: {},
                team: team || 'unknown',
                steamid: null,
              };
              playerMap.set(p.name, { playerData, team });
            }
          });
          
          // 等待所有搜索完成
          await Promise.all(playerPromises);
          
          // 按队伍分类
          playerMap.forEach(({ playerData, team }) => {
            if (team === 'CT' || team === 'ct') {
              cs2Team1.push(playerData);
            } else if (team === 'T' || team === 't') {
              cs2Team2.push(playerData);
            }
          });
        }
        
        // 如果 CS2 GSI 有数据，返回它
        if (cs2Team1.length > 0 || cs2Team2.length > 0) {
          this.response.type = 'application/json';
          this.response.body = {
            ok: true,
            match: {
              id: 'cs2-gsi',
              source: 'cs2-gsi',
              teams: {
                team1: {
                  id: 'CT',
                  name: map?.team_ct?.name || 'CT',
                  players: cs2Team1,
                },
                team2: {
                  id: 'T',
                  name: map?.team_t?.name || 'T',
                  players: cs2Team2,
                },
              },
            },
          };
          return;
        }
        
        this.response.type = 'application/json';
        this.response.body = { ok: true, match: null, message: '没有正在进行的对局' };
        return;
      }

      // 获取比赛详细信息
      const matchId = latestMatch.match_id;
      const matchRes = await superagent
        .get(`https://open.faceit.com/data/v4/matches/${matchId}`)
        .set('Authorization', `Bearer ${apiKey}`);

      const matchData = matchRes.body;

      // 解析队伍信息（Faceit API 可能使用 teams.faction1/faction2 或 teams.team1/team2）
      const team1Data = matchData.teams?.faction1 || matchData.teams?.team1 || {};
      const team2Data = matchData.teams?.faction2 || matchData.teams?.team2 || {};

      // 获取每个玩家的详细信息（包括统计数据）
      const getPlayerDetails = async (playerId: string) => {
        try {
          const playerRes = await superagent
            .get(`https://open.faceit.com/data/v4/players/${playerId}`)
            .set('Authorization', `Bearer ${apiKey}`);
          
          // 获取玩家统计数据
          let stats = {};
          try {
            const statsRes = await superagent
              .get(`https://open.faceit.com/data/v4/players/${playerId}/stats/cs2`)
              .set('Authorization', `Bearer ${apiKey}`);
            stats = statsRes.body?.lifetime || {};
          } catch (e) {
            logger.debug('获取玩家统计失败: %s', (e as Error).message);
          }
          
          return {
            id: playerRes.body.player_id,
            nickname: playerRes.body.nickname,
            avatar: playerRes.body.avatar,
            country: playerRes.body.country,
            elo: playerRes.body.games?.cs2?.faceit_elo || 0,
            level: playerRes.body.games?.cs2?.skill_level || 0,
            stats: {
              winRate: stats['Win Rate %'] ? parseFloat(stats['Win Rate %']) : 0,
              avg: stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0,
              kd: stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0,
              adr: stats['Average Damage per Round'] ? parseFloat(stats['Average Damage per Round']) : 0,
              hsPercent: stats['Average Headshots %'] ? parseFloat(stats['Average Headshots %']) : 0,
              totalKills: stats['Total Kills'] || 0,
            },
          };
        } catch (e) {
          logger.debug('获取玩家详情失败: %s', (e as Error).message);
          return null;
        }
      };

      // 获取双方队伍玩家详情
      const team1Players = [];
      const team2Players = [];

      const roster1 = team1Data.roster || team1Data.players || [];
      const roster2 = team2Data.roster || team2Data.players || [];

      for (const player of roster1) {
        const playerId = player.player_id || player.id;
        if (playerId) {
          const details = await getPlayerDetails(playerId);
          if (details) team1Players.push(details);
        }
      }

      for (const player of roster2) {
        const playerId = player.player_id || player.id;
        if (playerId) {
          const details = await getPlayerDetails(playerId);
          if (details) team2Players.push(details);
        }
      }

      this.response.type = 'application/json';
      this.response.body = {
        ok: true,
        match: {
          id: matchId,
          source: 'faceit',
          status: matchData.status,
          started_at: matchData.started_at,
          finished_at: matchData.finished_at,
          teams: {
            team1: {
              id: team1Data.team_id || team1Data.id,
              name: team1Data.name || 'Team 1',
              players: team1Players,
            },
            team2: {
              id: team2Data.team_id || team2Data.id,
              name: team2Data.name || 'Team 2',
              players: team2Players,
            },
          },
        },
      };
    } catch (e: any) {
      logger.debug('Faceit 对局 API 调用失败，尝试使用 CS2 GSI 数据并通过 Faceit API 搜索: %s', (e as Error).message);
      
      // 如果 Faceit API 失败，尝试使用 CS2 GSI 数据并通过 Faceit API 搜索每个玩家
      const cs2State = latestCs2State || {};
      const allPlayers = cs2State.allplayers || {};
      const map = cs2State.map || {};
      
      // 从 CS2 GSI 中提取所有玩家信息，并尝试通过 Faceit API 获取详细信息
      const cs2Team1: any[] = [];
      const cs2Team2: any[] = [];
      
      // 通过 Faceit API 搜索玩家信息的函数
      const searchPlayerBySteamId = async (steamId: string): Promise<any | null> => {
        if (!steamId || !apiKey) return null;
        try {
          const searchRes = await superagent
            .get('https://open.faceit.com/data/v4/players')
            .set('Authorization', `Bearer ${apiKey}`)
            .query({ game: 'cs2', game_player_id: steamId });
          
          if (searchRes.body?.player_id) {
            const playerId = searchRes.body.player_id;
            // 获取玩家详细信息
            const playerRes = await superagent
              .get(`https://open.faceit.com/data/v4/players/${playerId}`)
              .set('Authorization', `Bearer ${apiKey}`);
            
            // 获取玩家统计数据
            let stats = {};
            try {
              const statsRes = await superagent
                .get(`https://open.faceit.com/data/v4/players/${playerId}/stats/cs2`)
                .set('Authorization', `Bearer ${apiKey}`);
              stats = statsRes.body?.lifetime || {};
            } catch (e) {
              logger.debug('获取玩家统计失败: %s', (e as Error).message);
            }
            
            return {
              id: playerRes.body.player_id,
              nickname: playerRes.body.nickname,
              avatar: playerRes.body.avatar,
              country: playerRes.body.country,
              elo: playerRes.body.games?.cs2?.faceit_elo || 0,
              level: playerRes.body.games?.cs2?.skill_level || 0,
              stats: {
                winRate: stats['Win Rate %'] ? parseFloat(stats['Win Rate %']) : 0,
                avg: stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0,
                kd: stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0,
                adr: stats['Average Damage per Round'] ? parseFloat(stats['Average Damage per Round']) : 0,
                hsPercent: stats['Average Headshots %'] ? parseFloat(stats['Average Headshots %']) : 0,
                totalKills: stats['Total Kills'] || 0,
              },
            };
          }
        } catch (e) {
          logger.debug('通过 Steam ID 搜索 Faceit 玩家失败: %s', (e as Error).message);
        }
        return null;
      };
      
      if (allPlayers && typeof allPlayers === 'object') {
        // 并行搜索所有玩家
        const playerPromises: Promise<any>[] = [];
        const playerMap = new Map<string, any>();
        
        Object.values(allPlayers).forEach((p: any) => {
          if (!p || !p.name) return;
          const steamId = p.steamid;
          const team = p.team;
          
          if (steamId) {
            const promise = searchPlayerBySteamId(steamId).then((faceitData) => {
              const playerData = {
                id: faceitData?.id || steamId || p.name,
                nickname: faceitData?.nickname || p.name,
                avatar: faceitData?.avatar || null,
                country: faceitData?.country || null,
                elo: faceitData?.elo || null,
                level: faceitData?.level || null,
                stats: faceitData?.stats || {},
                team: team || 'unknown',
                steamid: steamId,
              };
              playerMap.set(steamId, { playerData, team });
            });
            playerPromises.push(promise);
          } else {
            // 没有 Steam ID，使用默认数据
            const playerData = {
              id: p.name,
              nickname: p.name,
              avatar: null,
              country: null,
              elo: null,
              level: null,
              stats: {},
              team: team || 'unknown',
              steamid: null,
            };
            playerMap.set(p.name, { playerData, team });
          }
        });
        
        // 等待所有搜索完成
        await Promise.all(playerPromises);
        
        // 按队伍分类
        playerMap.forEach(({ playerData, team }) => {
          if (team === 'CT' || team === 'ct') {
            cs2Team1.push(playerData);
          } else if (team === 'T' || team === 't') {
            cs2Team2.push(playerData);
          }
        });
      }
      
      // 如果 CS2 GSI 有数据，返回它
      if (cs2Team1.length > 0 || cs2Team2.length > 0) {
        this.response.type = 'application/json';
        this.response.body = {
          ok: true,
          match: {
            id: 'cs2-gsi',
            source: 'cs2-gsi',
            teams: {
              team1: {
                id: 'CT',
                name: map?.team_ct?.name || 'CT',
                players: cs2Team1,
              },
              team2: {
                id: 'T',
                name: map?.team_t?.name || 'T',
                players: cs2Team2,
              },
            },
          },
        };
        return;
      }
      
      // 如果 CS2 GSI 也没有数据，返回错误
      this.response.status = 500;
      this.response.type = 'application/json';
      this.response.body = {
        ok: false,
        error: e.response?.body?.errors?.[0]?.message || (e as Error).message,
      };
    }
  }
}

// Faceit API Handler - 获取玩家统计数据
class FaceitStatsHandler extends Handler<Context> {
  noCheckPermView = true;
  allowCors = true;

  async get() {
    const faceitConfig = (config as any).faceit || {};
    const apiKey = faceitConfig.apiKey || '';
    const playerId = faceitConfig.playerId || '';

    if (!apiKey) {
      this.response.status = 400;
      this.response.type = 'application/json';
      this.response.body = { ok: false, error: 'Faceit API Key 未配置' };
      return;
    }

    try {
      // 如果没有指定 playerId，尝试多种方式获取
      let targetPlayerId = playerId;
      
      if (!targetPlayerId) {
        // 方式1: 尝试通过用户名查找（从配置或查询参数）
        const nickname = this.request.query.nickname as string || '';
        if (nickname) {
          try {
            const searchRes = await superagent
              .get('https://open.faceit.com/data/v4/players')
              .set('Authorization', `Bearer ${apiKey}`)
              .query({ nickname });
            
            if (searchRes.body?.player_id) {
              targetPlayerId = searchRes.body.player_id;
              logger.debug('通过用户名找到 Player ID: %s', targetPlayerId);
            }
          } catch (e) {
            logger.debug('通过用户名获取 Faceit Player ID 失败: %s', (e as Error).message);
          }
        }
        
        // 方式2: 尝试从 CS2 GSI 数据中获取 Steam ID
        if (!targetPlayerId && latestCs2State?.player?.steamid) {
          try {
            const steamId = latestCs2State.player.steamid;
            const searchRes = await superagent
              .get('https://open.faceit.com/data/v4/players')
              .set('Authorization', `Bearer ${apiKey}`)
              .query({ game: 'cs2', game_player_id: steamId });
            
            if (searchRes.body?.player_id) {
              targetPlayerId = searchRes.body.player_id;
              logger.debug('通过 Steam ID 找到 Player ID: %s', targetPlayerId);
            }
          } catch (e) {
            logger.debug('通过 Steam ID 获取 Faceit Player ID 失败: %s', (e as Error).message);
          }
        }
      }

      if (!targetPlayerId) {
        this.response.status = 400;
        this.response.type = 'application/json';
        this.response.body = { 
          ok: false, 
          error: '未找到 Faceit Player ID。请在配置中设置 faceit.playerId，或在 URL 中添加 ?nickname=你的用户名' 
        };
        return;
      }

      // 获取玩家基本信息
      const playerRes = await superagent
        .get(`https://open.faceit.com/data/v4/players/${targetPlayerId}`)
        .set('Authorization', `Bearer ${apiKey}`);

      // 获取 CS2 游戏统计
      const statsRes = await superagent
        .get(`https://open.faceit.com/data/v4/players/${targetPlayerId}/stats/cs2`)
        .set('Authorization', `Bearer ${apiKey}`);

      // 获取最近比赛（获取更多以计算今日数据）
      const matchesRes = await superagent
        .get(`https://open.faceit.com/data/v4/players/${targetPlayerId}/history`)
        .set('Authorization', `Bearer ${apiKey}`)
        .query({ game: 'cs2', limit: 20 }); // 获取最近20场比赛

      const playerData = playerRes.body;
      const statsData = statsRes.body;
      const matchesData = matchesRes.body;

      // 计算今日数据
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTimestamp = today.getTime();

      let todayWins = 0;
      let todayLosses = 0;
      let todayEloChange = 0;

      const matches = matchesData.items || [];
      for (const match of matches) {
        const matchDate = new Date(match.finished_at * 1000);
        if (matchDate >= today) {
          const isWin = match.results?.winner === targetPlayerId;
          if (isWin) {
            todayWins++;
          } else {
            todayLosses++;
          }
          // 计算 ELO 变化（从 match 数据中获取）
          if (match.elo && match.elo_before) {
            const eloChange = match.elo - match.elo_before;
            todayEloChange += eloChange;
          }
        } else {
          break; // 已经过了今天，不需要继续
        }
      }

      const currentElo = playerData.games?.cs2?.faceit_elo || 0;
      const currentLevel = playerData.games?.cs2?.skill_level || 0;

      this.response.type = 'application/json';
      this.response.body = {
        ok: true,
        player: {
          id: playerData.player_id,
          nickname: playerData.nickname,
          avatar: playerData.avatar,
          country: playerData.country,
          // ELO 和等级
          games: playerData.games?.cs2 || {},
          elo: currentElo,
          level: currentLevel,
        },
        stats: statsData.lifetime || {},
        lastMatch: matches[0] || null,
        today: {
          wins: todayWins,
          losses: todayLosses,
          eloChange: todayEloChange,
        },
      };
    } catch (e: any) {
      logger.error('Faceit API 调用失败: %s', (e as Error).message);
      this.response.status = 500;
      this.response.type = 'application/json';
      this.response.body = {
        ok: false,
        error: e.response?.body?.errors?.[0]?.message || (e as Error).message,
      };
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
    
    // 订阅 TTS 音频和 Agent 内容事件
    try {
      const ctx = this.ctx;
      const ttsHandler = (audioData: any) => {
        try {
          this.send({
            type: 'tts/audio',
            data: audioData,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 TTS 音频失败: %s', (e as Error).message);
        }
      };
      
      const contentHandler = (contentData: any) => {
        try {
          this.send({
            type: 'agent/content',
            data: contentData,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 Agent 内容失败: %s', (e as Error).message);
        }
      };
      
      const contentStartHandler = (data: any) => {
        try {
          this.send({
            type: 'agent/content/start',
            data: data,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 Agent 内容开始失败: %s', (e as Error).message);
        }
      };
      
      const contentEndHandler = (data: any) => {
        try {
          this.send({
            type: 'agent/content/end',
            data: data,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 Agent 内容结束失败: %s', (e as Error).message);
        }
      };
      
      const messageHandler = (messageData: any) => {
        try {
          this.send({
            type: 'agent/message',
            data: messageData,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 Agent 消息失败: %s', (e as Error).message);
        }
      };
      
      const ttsStartHandler = (data: any) => {
        try {
          this.send({
            type: 'tts/start',
            data: data,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 TTS 开始失败: %s', (e as Error).message);
        }
      };
      
      const ttsEndHandler = (data: any) => {
        try {
          this.send({
            type: 'tts/end',
            data: data,
            ts: Date.now(),
          });
        } catch (e) {
          logger.debug('[projection-ws] 发送 TTS 结束失败: %s', (e as Error).message);
        }
      };
      
      ctx.on('projection/tts/audio', ttsHandler);
      ctx.on('projection/tts/start', ttsStartHandler);
      ctx.on('projection/tts/end', ttsEndHandler);
      ctx.on('projection/agent/content', contentHandler);
      ctx.on('projection/agent/content/start', contentStartHandler);
      ctx.on('projection/agent/content/end', contentEndHandler);
      ctx.on('projection/agent/message', messageHandler);
      
      // 保存处理器引用以便清理
      (this as any)._ttsHandler = ttsHandler;
      (this as any)._ttsStartHandler = ttsStartHandler;
      (this as any)._ttsEndHandler = ttsEndHandler;
      (this as any)._contentHandler = contentHandler;
      (this as any)._contentStartHandler = contentStartHandler;
      (this as any)._contentEndHandler = contentEndHandler;
      (this as any)._messageHandler = messageHandler;
    } catch (e) {
      logger.debug('[projection-ws] 订阅事件失败: %s', (e as Error).message);
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
    
    // 清理事件监听器（使用全局 Context，避免 inject 问题）
    try {
      const globalCtx = (global as any).__cordis_ctx;
      if (globalCtx) {
        const ttsHandler = (this as any)._ttsHandler;
        const ttsStartHandler = (this as any)._ttsStartHandler;
        const ttsEndHandler = (this as any)._ttsEndHandler;
        const contentHandler = (this as any)._contentHandler;
        const contentStartHandler = (this as any)._contentStartHandler;
        const contentEndHandler = (this as any)._contentEndHandler;
        const messageHandler = (this as any)._messageHandler;
        
        if (ttsHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/tts/audio', ttsHandler);
        }
        if (ttsStartHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/tts/start', ttsStartHandler);
        }
        if (ttsEndHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/tts/end', ttsEndHandler);
        }
        if (contentHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/agent/content', contentHandler);
        }
        if (contentStartHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/agent/content/start', contentStartHandler);
        }
        if (contentEndHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/agent/content/end', contentEndHandler);
        }
        if (messageHandler && typeof globalCtx.off === 'function') {
          globalCtx.off('projection/agent/message', messageHandler);
        }
      }
    } catch (e) {
      // 忽略清理错误，连接已断开，监听器会自动失效
      // logger.debug('[projection-ws] 清理事件监听器失败: %s', (e as Error).message);
    }
    
    logger.debug('[projection-ws] 前端连接已断开，当前连接数: %d', projectionConnections.size);
  }
}

// Widget 配置 API Handler
class WidgetConfigHandler extends Handler<Context> {
  noCheckPermView = true;
  allowCors = true;

  async get() {
    try {
      const widgetName = this.request.query.widgetName as string;
      
      await this.ctx.inject(['dbservice'], async (ctx) => {
        if (widgetName) {
          // 获取单个组件的配置
          const doc = await ctx.db.widgetConfig.findOne({ widgetName });
          if (doc) {
            this.response.body = { success: true, config: doc.config };
          } else {
            this.response.body = { success: true, config: null };
          }
        } else {
          // 获取所有组件的配置
          const docs = await ctx.db.widgetConfig.find({});
          const configs: Record<string, any> = {};
          for (const doc of docs) {
            configs[doc.widgetName] = doc.config;
          }
          this.response.body = { success: true, configs };
        }
        this.response.type = 'application/json';
      });
    } catch (e) {
      logger.error('获取 Widget 配置失败: %s', (e as Error).message);
      this.response.status = 500;
      this.response.type = 'application/json';
      this.response.body = { error: (e as Error).message };
    }
  }

  async post() {
    try {
      logger.info('[WidgetConfig] POST 请求，body: %o', this.request.body);
      const body = this.request.body || {};
      const { widgetName, config } = body;
      
      logger.info('[WidgetConfig] 解析参数: widgetName=%s, config存在=%s', widgetName, !!config);
      
      if (!widgetName || !config) {
        logger.error('[WidgetConfig] 缺少必要参数: widgetName=%s, config=%o', widgetName, config);
        this.response.status = 400;
        this.response.type = 'application/json';
        this.response.body = { error: '缺少必要参数: widgetName 和 config', received: { widgetName: !!widgetName, config: !!config } };
        return;
      }

      // 直接使用 this.ctx.db（通过 mixin 暴露），参考其他 handler 的做法
      const now = Date.now();
      const existing = await this.ctx.db.widgetConfig.findOne({ widgetName });
      logger.info('[WidgetConfig] 查找现有配置: widgetName=%s, 存在=%s', widgetName, !!existing);
      
      if (existing) {
        // 更新现有配置
        logger.info('[WidgetConfig] 更新配置: widgetName=%s, stylePreset=%s', widgetName, config?.stylePreset);
        await this.ctx.db.widgetConfig.update(
          { widgetName },
          { $set: { config, updatedAt: now } }
        );
      } else {
        // 创建新配置
        logger.info('[WidgetConfig] 创建新配置: widgetName=%s, stylePreset=%s', widgetName, config?.stylePreset);
        await this.ctx.db.widgetConfig.insert({
          _id: widgetName,
          widgetName,
          config,
          createdAt: now,
          updatedAt: now,
        });
      }
      
      // 验证保存是否成功
      const savedDoc = await this.ctx.db.widgetConfig.findOne({ widgetName });
      logger.info('[WidgetConfig] 保存后验证: widgetName=%s, 存在=%s, stylePreset=%s', 
        widgetName, !!savedDoc, savedDoc?.config?.stylePreset);
      
      this.response.type = 'application/json';
      this.response.body = { success: true, saved: !!savedDoc };
      logger.info('[WidgetConfig] 响应已设置: %o', this.response.body);
    } catch (e) {
      logger.error('[WidgetConfig] 保存 Widget 配置失败: %s', (e as Error).message);
      this.response.status = 500;
      this.response.type = 'application/json';
      this.response.body = { error: (e as Error).message };
    }
  }
}

export async function apply(ctx: Context) {
  // 在默认 server 模式下注册（不区分 client / node / provider）
  // 注意：路由注册顺序很重要，具体路由要在通配符路由之前
  ctx.Route('projection-ui-static', '/main.js', ProjectionUIStaticHandler);
  
  // 为每个 widget 注册独立的路由 handler（必须在通配符路由之前）
  ctx.Route('weapons', '/widget/weapons', WeaponsHandler);
  ctx.Route('player', '/widget/player', PlayerHandler);
  ctx.Route('health', '/widget/health', HealthHandler);
  ctx.Route('armor', '/widget/armor', ArmorHandler);
  ctx.Route('score', '/widget/score', ScoreHandler);
  ctx.Route('bomb', '/widget/bomb', BombHandler);
  ctx.Route('stats', '/widget/stats', StatsHandler);
  ctx.Route('round', '/widget/round', RoundHandler);
  ctx.Route('faceit', '/widget/faceit', FaceitHandler);
  ctx.Route('matchteams', '/widget/matchteams', MatchTeamsHandler);
  ctx.Route('myteam', '/widget/myteam', MyTeamHandler);
  ctx.Route('enemyteam', '/widget/enemyteam', EnemyTeamHandler);
  ctx.Route('agentstream', '/widget/agentstream', AgentStreamHandler);
  ctx.Route('emoji', '/widget/emoji', EmojiHandler);
  ctx.Route('tts', '/widget/tts', TTSHandler);
  
  // 根路径返回 HTML，用于显示 Dashboard 和其他页面
  // 这确保 BrowserRouter 的所有路由都能正确加载
  ctx.Route('projection-ui-root', '/', ProjectionUIHomeHandler);
  
  ctx.Route('projection-state', '/api/projection/state', ProjectionStateHandler);
  ctx.Route('projection-info', '/api/projection/info', ProjectionInfoHandler);
  // CS2 GSI 入口，提供多个别名路径，方便在游戏里配置
  ctx.Route('projection-cs2-gsi', '/api/projection/cs2-gsi', ProjectionCs2GSIHandler);
  ctx.Route('projection-cs2-gsi-short', '/cs2-gsi', ProjectionCs2GSIHandler);
  ctx.Route('projection-cs2-gsi-alt', '/projection/cs2-gsi', ProjectionCs2GSIHandler);
  // Faceit API
  ctx.Route('faceit-stats', '/api/projection/faceit', FaceitStatsHandler);
  ctx.Route('faceit-match', '/api/projection/faceit-match', FaceitMatchHandler);
  // Widget 配置 API
  ctx.Route('widget-config', '/api/projection/widget-config', WidgetConfigHandler);
  // 表情包图片服务
  ctx.Route('projection-image', '/images/:name', ProjectionImageHandler);
  ctx.Connection('projection-ws', '/projection-ws', ProjectionWebSocketHandler);
}


