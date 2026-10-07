# 控制流支配关系与支配边界核验服务

一个 Windows 本地可运行的离线必经节点（支配）分析后端：TypeScript + Node.js + SQLite，只提供 HTTP API 与 CLI，不编译源代码、不构造 SSA、不模拟指令执行。

## 概念（用路径含义解释）

给定入口 `entry` 和有向跳转边构成的控制流图：

- **支配（dominate）**：`a` 支配 `b`，当且仅当从入口到 `b` 的**每一条**路径都经过 `a`。换句话说，把 `a` 从图中删掉后 `b` 就不可达了。
- **严格支配（strictly dominate）**：`a` 支配 `b` 且 `a ≠ b`。任何节点都支配它自己，但不严格支配自己。
- **立即支配者（immediate dominator, idom）**：`b` 的所有严格支配者中"离 `b` 最近"的那个——它被其他所有严格支配者所支配。入口没有立即支配者。所有 idom 关系组成一棵以入口为根的**支配树**。
- **支配边界（dominance frontier）**：`y ∈ DF(x)` 当且仅当 `x` 支配 `y` 的至少一个可达前驱，但 `x` 不严格支配 `y`。因为严格支配不含自身，循环回边可能让节点出现在自己的支配边界中（例如循环头 `h`：`h` 支配循环体这个前驱，但不严格支配自己）。

## 算法口径

核心是**支配集合的不动点迭代**（`src/dominator.ts`）：

1. `Dom(entry) = {entry}`，其余可达块初始化为全部可达块。
2. 每轮按固定顺序（节点编号字典序）遍历：`Dom(n) = {n} ∪ ⋂ Dom(p)`，其中 `p` 取遍 `n` 的**可达**前驱。
3. 重复直到某轮没有任何集合变化；保留每轮的变化数作为收敛摘要（`rounds`）。
4. idom 从稳定后的支配集合推导（严格支配者中被所有其他严格支配者支配的唯一一个），不取 DFS 父节点。
5. 支配边界按标准定义枚举。

其他约定：

- 入口即使有回边也保持 `Dom(entry) = {entry}`。
- 平行边（重复边）在计算时归并，但原始输入原样保存。
- 入口以外不可达的块单独列入 `unreachable`，不加入任何可达块的支配集合，也不进支配树。
- 查询 `a` 是否支配 `b` 时，若不成立，返回一条**避开 `a` 仍从入口到达 `b` 的真实路径**（BFS 求得）作为反例；`b` 不可达时返回 `dominates: null`（不适用）。

## 安装与运行

要求：Node.js ≥ 22（使用内置 `node:sqlite`，无原生依赖、无需 Docker/WSL/网络服务）。

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo      # 演示：菱形图 → 加绕行边新版本 → 对比
```

端口配置：`$env:PORT=8080; npm start`，或 `node dist/src/cli.js serve 8080`；不传端口时自动选择空闲端口并打印实际地址。

数据目录：项目内 `data/dominator.db`（可用环境变量 `DOM_DATA_DIR` / `DOM_DB_PATH` 覆盖）。重启后历史图与分析结果仍可读取。

规模上限（`GET /limits` 或 `cli limits` 查看）：节点 10000、边 50000，可用 `DOM_MAX_NODES` / `DOM_MAX_EDGES` 调整。

## 图格式

```json
{
  "nodes": ["s", "a", "b", "j", "z"],
  "entry": "s",
  "edges": [{ "from": "s", "to": "a" }]
}
```

孤立块也要写进 `nodes`。导入前校验：空图（`EMPTY_GRAPH`）、编号重复（`DUPLICATE_NODE`）、入口无效（`INVALID_ENTRY`）、边端点缺失（`MISSING_ENDPOINT`）、超限（`LIMIT_EXCEEDED`）、格式错误（`VALIDATION_ERROR`）。校验失败不写入任何数据。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/graphs` | 导入图（**每次导入都是新的不可变版本**），分析后返回 `{ graphId, result }` |
| GET | `/graphs` | 历史版本列表 |
| GET | `/graphs/:id` | 读取原图与元信息 |
| POST | `/graphs/:id/analyze` | 重新分析该版本 |
| GET | `/graphs/:id/result` | 导出已存分析结果（JSON） |
| GET | `/graphs/:id/dominates?a=&b=` | 查询支配关系，不成立时附反例路径 |
| GET | `/graphs/:id/idom-tree` | 立即支配者与支配树 |
| GET | `/graphs/:id/frontier?node=` | 支配边界（省略 `node` 返回全部） |
| GET | `/limits` | 节点/边上限 |

错误响应统一为 `{ "error": { "code", "message" } }`。

## CLI

```powershell
node dist/src/cli.js import examples/diamond.json   # 导入并打印收敛摘要、支配集合、idom、支配边界
node dist/src/cli.js query 1 a j                    # no + 反例路径 s -> b -> j
node dist/src/cli.js tree 1                         # 支配树
node dist/src/cli.js frontier 1 a                   # DF(a) = {j}
node dist/src/cli.js export 1 result.json           # 导出结果
node dist/src/cli.js list                           # 历史版本
node dist/src/cli.js analyze 1                      # 重新分析
node dist/src/cli.js serve 8080                     # 启动 HTTP 服务
```

## 演示内容

`npm run demo` 会：

1. 导入菱形图 `s→a, s→b, a→j, b→j, j→z`：`idom(j)=s`、`idom(z)=j`、`DF(a)=DF(b)={j}`，并展示集合收敛轮次；
2. 查询 `a` 是否支配 `j`，给出反例路径 `s -> b -> j`；
3. 增加绕行边 `s→j` 导入为**新版本**，对比支配关系；
4. 证明旧版本报告保持不变。

注意：演示基于全新数据库（id 从 1 开始）。重复演示前可删除 `data/` 目录。

## 测试

`npm test` 覆盖：

- **独立核验**：用"删除候选节点后做可达性检查"作为预言机核对全部支配关系，并按定义枚举支配边界，不用生产算法验证自身；
- 菱形分支、带回边循环（节点可在自己的支配边界中）、入口回边、单块图、孤立块；
- 块编号重排结论不变、重复边归并、深链（200 块）、循环、断开分支；
- 反例路径逐边核实真实存在且避开候选块；
- API 错误码、失败导入无残留数据、CLI 输出、进程重启后（重开 SQLite 文件）结果读取。

## 限制

- 不动点迭代为朴素实现（位集未优化），不追求最优复杂度；默认上限 1 万节点 / 5 万边。
- 只分析给定图：不解析源代码、不构造 SSA、不做指令级模拟。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时通过 `--disable-warning=ExperimentalWarning` 抑制警告），升级 Node 大版本时请留意。
- 结果展示（如 CLI 摘要）可截断，但存储与计算结论始终完整。
