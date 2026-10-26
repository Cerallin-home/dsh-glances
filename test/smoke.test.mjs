/**
 * 冒烟测试：需要有 glances 在跑（默认 127.0.0.1:61208），没跑就整体跳过。
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectStatus,
  collectTop,
  evaluateAlerts,
  renderStatus,
  DEFAULT_THRESHOLDS,
} from '../lib/glances.js';

const BASE = process.env.GLANCES_URL || 'http://127.0.0.1:61208/api/4';

async function glancesUp() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await glancesUp();
const opts = { skip: up ? false : `glances 没在 ${BASE} 上跑，跳过` };

test('host status 有 cpu/内存/负载/磁盘/温度', opts, async () => {
  const s = await collectStatus({ baseUrl: BASE, diskPaths: ['/'] });
  assert.ok(s.cores >= 1, 'cores');
  assert.ok(s.cpu.totalPercent >= 0 && s.cpu.totalPercent <= 100, `cpu ${s.cpu.totalPercent}`);
  assert.ok(s.load.min1 >= 0, 'load1');
  assert.ok(s.mem && s.mem.totalGb > 0, 'mem');
  assert.ok(s.mem.percent >= 0 && s.mem.percent <= 100, 'mem percent');
  assert.ok(s.disks.length >= 1, 'disks');
  assert.ok(s.disks[0].percent > 0 && s.disks[0].sizeGb > 0, 'disk numbers');
  assert.ok(s.cpuTemp && s.cpuTemp.celsius > 0, 'cpu temp');
  const text = renderStatus(s);
  assert.match(text, /CPU \d/);
  assert.match(text, /磁盘/);
});

test('top 进程按 cpu / 内存排序', opts, async () => {
  const cpu = await collectTop({ baseUrl: BASE, limit: 5, sortBy: 'cpu' });
  assert.equal(cpu.rows.length, Math.min(5, cpu.total));
  for (let i = 1; i < cpu.rows.length; i += 1) {
    assert.ok(cpu.rows[i - 1].cpuPercent >= cpu.rows[i].cpuPercent, 'cpu 降序');
  }
  const mem = await collectTop({ baseUrl: BASE, limit: 3, sortBy: 'memory' });
  for (let i = 1; i < mem.rows.length; i += 1) {
    assert.ok(mem.rows[i - 1].memPercent >= mem.rows[i].memPercent, 'mem 降序');
  }
});

test('阈值体检：默认线不误报，压低阈值会报出来', opts, async () => {
  const s = await collectStatus({ baseUrl: BASE, diskPaths: ['/'] });
  const loose = evaluateAlerts(s, { cpuPercent: 100, memPercent: 100, diskPercent: 100, tempCelsius: 120, loadPerCore: 99, swapPercent: 100 });
  assert.equal(loose.ok, true, '宽松阈值应无告警');
  const strict = evaluateAlerts(s, { cpuPercent: 0, memPercent: 0, diskPercent: 0, tempCelsius: 0, loadPerCore: 0, swapPercent: 0 });
  assert.equal(strict.ok, false, '零阈值必须报警');
  assert.ok(strict.issues.length >= 3, `issues ${strict.issues.length}`);
  assert.ok(Object.keys(DEFAULT_THRESHOLDS).length >= 5, '默认阈值齐全');
});
