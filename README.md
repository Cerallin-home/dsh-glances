# dsh-glances

树莓派整机监控插件。数据来自 [glances](https://github.com/nicolargo/glances) 的 REST API，
把 CPU、负载、内存、swap、磁盘、温度、风扇凑成一次快照，交给 DSH 的模型和脚本用。

```
host_status   CPU / 负载 / 内存 / swap / 磁盘 / 温度 / 风扇，一次看全
host_top      最吃 CPU 或内存的进程
host_alerts   阈值体检 + glances 自带告警
```

## 装

```bash
dsh plugin --profile <name> add link:/path/to/dsh-glances
```

`cordis.patch.yml` 会把自己的配置行插进 profile；glances 默认地址
`http://127.0.0.1:61208/api/4`，改 `baseUrl` 就能连别的机器（glances 开 `-w`）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:61208/api/4` | glances REST 根地址 |
| `timeoutMs` | `4000` | 单次请求超时 |
| `diskPaths` | `['/']` | 用 statfs 量占用的路径，同分区只报一次 |
| `cpuPercent` | `85` | CPU 告警线 |
| `memPercent` | `85` | 内存告警线 |
| `swapPercent` | `85` | swap 告警线（这台机器 swap 常驻 60% 上下，别设太低） |
| `diskPercent` | `90` | 磁盘告警线 |
| `tempCelsius` | `78` | 温度告警线（树莓派 80℃ 软降频） |
| `loadPerCore` | `1.5` | 每核负载告警线 |

## 命令行

不开 dsh 也能看，`boot-notify.sh` 用的就是这条：

```bash
node lib/cli.js            # 多行详情
node lib/cli.js --line     # 一行摘要
node lib/cli.js --json     # 结构化数据
node lib/cli.js --check    # 阈值体检，超线退出码 1
```

## 两个实现细节（踩过的坑）

- **磁盘不用 glances**：glances 跑在 docker 里，`/api/4/fs` 只看得见容器自己的
  `/etc/resolv.conf` 这类挂载，宿主机的 `/` 根本不在里面。所以磁盘占用由插件进程
  自己 `statfs`（dsh 就跑在这台机器上），glances 的 fs 结果只在看得见真实挂载点时补充。
- **CPU 百分比要挑有效采样窗**：glances 的百分比是"上次采样到这次"的差值。隔久了第一次
  全是 0，两次请求挨太近又会给出 `total=50 / user=0` 这种自相矛盾的窗口。插件会检查
  `idle+user+system+iowait ≈ 100`，不成立就重试（最多 4 次），拿不到就报 0 而不是报假数。

## 测试

```bash
node --test test/*.test.mjs    # glances 没在跑就整体跳过
```

MIT。
