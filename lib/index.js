/**
 * dsh-glances — 树莓派整机监控（数据来自 glances REST API）
 *
 * 工具：
 *  - host_status()               CPU / 内存 / swap / 负载 / 磁盘 / 温度 / 风扇 一眼看全
 *  - host_top(sortBy, limit)     最吃 CPU 或内存的进程
 *  - host_alerts()               阈值体检 + glances 自带告警
 *
 * 磁盘占用由 statfs 直接算：glances 跑在容器里，/api/4/fs 看不到宿主的 /。
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  DEFAULT_BASE,
  collectStatus,
  collectTop,
  evaluateAlerts,
  fetchJson,
  renderStatus,
  renderTop,
  renderAlerts,
} from './glances.js';

export const name = 'dsh-glances';
export const inject = ['tools'];

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE),
  timeoutMs: z.number().step(1).min(500).default(4000),
  diskPaths: z.array(z.string()).default(['/']),
  mountPrefix: z.string().default('/nvme0n1'),
  includeGlancesAlerts: z.boolean().default(false),
  cpuPercent: z.number().step(1).min(1).default(85),
  memPercent: z.number().step(1).min(1).default(85),
  swapPercent: z.number().step(1).min(1).default(85),
  diskPercent: z.number().step(1).min(1).default(90),
  tempCelsius: z.number().step(1).min(1).default(78),
  loadPerCore: z.number().step(0.1).min(0.1).default(1.5),
});

export function apply(ctx, config) {
  const cfg = { ...config };
  const logger = ctx.logger ?? console;
  const thresholds = () => ({
    cpuPercent: cfg.cpuPercent,
    memPercent: cfg.memPercent,
    swapPercent: cfg.swapPercent,
    diskPercent: cfg.diskPercent,
    tempCelsius: cfg.tempCelsius,
    loadPerCore: cfg.loadPerCore,
  });

  async function status() {
    return collectStatus({
      baseUrl: cfg.baseUrl,
      timeoutMs: cfg.timeoutMs,
      diskPaths: cfg.diskPaths ?? ['/'],
      mountPrefix: cfg.mountPrefix ?? '',
    });
  }

  ctx.tools.register(
    defineTool({
      name: 'host_status',
      description:
        "Snapshot of this Raspberry Pi: CPU, load average, memory, swap, disk usage, temperatures and fan. Data comes from the local glances REST API (port 61208); disks are measured with statfs. Use when asked about 状态 / 温度 / 内存 / 负载 / 磁盘 / 机器怎么样.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ts: { type: 'string', required: true },
            host: { type: 'string', required: true },
            uptime: { type: 'string', required: true },
            cores: { type: 'number', required: true },
            cpuPercent: { type: 'number', required: true },
            cpuDetail: { type: 'string', required: true },
            load1: { type: 'number', required: true },
            load5: { type: 'number', required: true },
            load15: { type: 'number', required: true },
            loadPerCore: { type: 'number', required: true },
            memPercent: { type: 'number', required: true },
            memDetail: { type: 'string', required: true },
            swapPercent: { type: 'number', required: true },
            disks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  percent: { type: 'number', required: true },
                  sizeGb: { type: 'number', required: true },
                  usedGb: { type: 'number', required: true },
                  freeGb: { type: 'number', required: true },
                },
              },
            },
            cpuTemp: { type: 'number', required: true },
            nvmeTemp: { type: 'number', required: true },
            fanRpm: { type: 'number', required: true },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        const s = await status();
        const value = {
          ts: s.ts,
          host: s.host,
          uptime: s.uptime,
          cores: s.cores,
          cpuPercent: s.cpu.totalPercent,
          cpuDetail: `user ${s.cpu.userPercent}% / sys ${s.cpu.systemPercent}% / iowait ${s.cpu.iowaitPercent}%${s.cpu.source === 'proc' ? '（本机采样）' : ''}${s.cpu.model ? ` (${s.cpu.model})` : ''}`,
          load1: s.load.min1,
          load5: s.load.min5,
          load15: s.load.min15,
          loadPerCore: s.load.perCore,
          memPercent: s.mem?.percent ?? 0,
          memDetail: s.mem ? `用 ${s.mem.usedGb}G / 共 ${s.mem.totalGb}G，可用 ${s.mem.availableGb}G，cache ${s.mem.cachedGb}G` : '读不到',
          swapPercent: s.swap?.percent ?? 0,
          disks: (s.disks ?? [])
            .filter((d) => !d.error)
            .map((d) => ({ path: d.path, percent: d.percent, sizeGb: d.sizeGb, usedGb: d.usedGb, freeGb: d.freeGb })),
          cpuTemp: s.cpuTemp?.celsius ?? 0,
          nvmeTemp: s.nvmeTemp?.celsius ?? 0,
          fanRpm: s.fanRpm ?? 0,
          warnings: s.warnings ?? [],
          text: renderStatus(s),
        };
        logger.debug?.(`host_status: cpu ${value.cpuPercent}% mem ${value.memPercent}%`);
        return value;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'host_top',
      description:
        'Top processes on this Raspberry Pi by CPU or memory usage (from glances). Use when something feels slow and you need to know what is eating CPU/RAM.',
      parameters: {
        sortBy: { type: 'string', enum: ['cpu', 'memory'], description: 'Sort by cpu (default) or memory.' },
        limit: { type: 'number', description: 'How many rows (1-20, default 5).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sortBy: { type: 'string', required: true },
            limit: { type: 'number', required: true },
            total: { type: 'number', required: true },
            rows: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pid: { type: 'number', required: true },
                  name: { type: 'string', required: true },
                  user: { type: 'string', required: true },
                  cpuPercent: { type: 'number', required: true },
                  memPercent: { type: 'number', required: true },
                  rssMb: { type: 'number', required: true },
                  cmdline: { type: 'string', required: true },
                },
              },
            },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const v = await collectTop({
          baseUrl: cfg.baseUrl,
          timeoutMs: cfg.timeoutMs,
          sortBy: args.sortBy,
          limit: args.limit,
        });
        return { ...v, text: renderTop(v) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'host_alerts',
      description:
        'Health check for this Raspberry Pi: compares CPU / memory / swap / load / disk / temperature against the configured thresholds and merges glances own alerts. Returns ok=true when everything is inside the lines.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            issues: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  metric: { type: 'string', required: true },
                  level: { type: 'string', required: true },
                  value: { type: 'number', required: true },
                  limit: { type: 'number', required: true },
                  text: { type: 'string', required: true },
                },
              },
            },
            cpuTemp: { type: 'number', required: true },
            cpuPercent: { type: 'number', required: true },
            memPercent: { type: 'number', required: true },
            diskPercent: { type: 'number', required: true },
            loadPerCore: { type: 'number', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        const s = await status();
        let raw = [];
        if (cfg.includeGlancesAlerts) {
          try {
            const alerts = await fetchJson(cfg.baseUrl, '/alert', cfg.timeoutMs);
            raw = Array.isArray(alerts) ? alerts : [];
          } catch {
            raw = [];
          }
        }
        const v = evaluateAlerts(s, thresholds(), raw);
        const worst = Math.max(0, ...(s.disks ?? []).map((d) => Number(d.percent) || 0));
        return {
          ok: v.ok,
          issues: v.issues,
          cpuTemp: s.cpuTemp?.celsius ?? 0,
          cpuPercent: s.cpu.totalPercent,
          memPercent: s.mem?.percent ?? 0,
          diskPercent: worst,
          loadPerCore: s.load.perCore,
          text: renderAlerts(v),
        };
      },
    }),
  );
}
