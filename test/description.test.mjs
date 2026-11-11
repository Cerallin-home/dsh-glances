/**
 * host_alerts 的工具描述跟着 includeGlancesAlerts 走：关了不提 glances 自带告警。
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { alertsDescription } from '../lib/glances.js';

const MERGE = 'merges glances own alerts';

test('includeGlancesAlerts 关：描述不提 glances 自带告警', () => {
  const d = alertsDescription(false);
  assert.equal(d.includes(MERGE), false, `不该出现「${MERGE}」：${d}`);
  assert.match(d, /against the configured thresholds\. Returns ok=true/, '句子要连着');
});

test('includeGlancesAlerts 开：描述写明并 glances 的告警', () => {
  const d = alertsDescription(true);
  assert.equal(d.includes(MERGE), true, `应该出现「${MERGE}」：${d}`);
  assert.match(d, /and merges glances own alerts\. Returns ok=true/, '连接词要在');
});

test('两种描述开头一致，只差中间那一段', () => {
  const off = alertsDescription(false);
  const on = alertsDescription(true);
  const head = 'Health check for this Raspberry Pi:';
  assert.ok(off.startsWith(head) && on.startsWith(head), '开头一致');
  assert.ok(on.length > off.length, '开着的更长');
});
