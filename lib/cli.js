#!/usr/bin/env node
/**
 * dsh-glances 的命令行入口：不开 dsh 也能看一眼机器。
 *
 *   node lib/cli.js              # 多行详情
 *   node lib/cli.js --line       # 一行摘要（boot-notify.sh 用这个）
 *   node lib/cli.js --json       # 原始结构化数据
 *   node lib/cli.js --check      # 阈值体检，超线时退出码 1
 */
import { collectStatus, evaluateAlerts, renderStatus, renderAlerts } from './glances.js';

const args = new Set(process.argv.slice(2));
const baseUrl = process.env.GLANCES_URL || 'http://127.0.0.1:61208/api/4';
const diskPaths = (process.env.GLANCES_DISKS || '/').split(',').filter(Boolean);

let status;
try {
  status = await collectStatus({ baseUrl, diskPaths });
} catch (error) {
  console.error(`💀 ${error?.message ?? error}`);
  process.exit(2);
}

if (args.has('--json')) {
  console.log(JSON.stringify(status, null, 2));
} else if (args.has('--check')) {
  const verdict = evaluateAlerts(status);
  console.log(renderAlerts(verdict));
  process.exit(verdict.ok ? 0 : 1);
} else if (args.has('--line')) {
  const disk = (status.disks ?? []).find((d) => !d.error) ?? {};
  const parts = [
    `CPU ${status.cpu.totalPercent}%`,
    `内存 ${status.mem?.percent ?? '?'}%`,
    `负载 ${status.load.min1}`,
    `磁盘已用 ${disk.percent ?? '?'}%（剩 ${disk.freeGb ?? '?'}GB）`,
    `CPU ${status.cpuTemp?.celsius ?? '?'}℃`,
  ];
  console.log(parts.join(' ｜ '));
} else {
  console.log(renderStatus(status));
}
