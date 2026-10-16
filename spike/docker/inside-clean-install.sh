#!/usr/bin/env bash
# 在**容器内部**跑的验收脚本（P6 验收标准 4：干净安装/卸载）。
#
# 单独一个文件而不是塞进 `bash -lc '...'`：嵌套引号会把脚本变成不可读的转义迷宫，
# 而且一旦里面用到单引号就会直接把外层字符串截断（第一版就是这么坏的）。
#
# **检查顺序很重要**：preset 是在插件 apply（也就是**首次启动 DSH**）时物化的，
# 不是 `dsh plugin add` 时。所以必须「先启动、再查 preset」——
# 第一版把顺序写反了，于是把"还没启动"误报成"preset 没投递"。
#
# 期望环境：/art/*.tgz（只读挂载）、DSH_VERSION
set -uo pipefail

pass=0; fail=0; skipped=0
ck() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1${3:+  → $3}"; fi }
# 「跳过」与「失败」必须分开：宿主自身装不起来时，把依赖它的检查报成失败是在甩锅给被测插件。
skip() { skipped=$((skipped+1)); echo "  ⏭  $1${2:+  → $2}"; }
HOME_DIR="${HOME:-/root}"
export DSH_HOME="$HOME_DIR/.dsh"
PRESET="$DSH_HOME/.agent-presets/quant-assistant"
PROFILE="$DSH_HOME/profiles/web"

echo "--- 环境 ---"
echo "  node $(node -v)  npm $(npm -v)  dsh 目标 $DSH_VERSION  DSH_HOME=$DSH_HOME"
ck "Node 主版本 >= 22（node:sqlite 需要）" "$(node -e 'console.log(+process.versions.node.split(".")[0]>=22?1:0)')"

echo
echo "--- 装 pnpm 与 dsh ---"
if npm i -g pnpm >/tmp/pnpm.log 2>&1; then ck "pnpm 装上" 1; else ck "pnpm 装上" 0 "$(tail -2 /tmp/pnpm.log)"; fi
if npm i -g "@deepseek-ai/dsh@$DSH_VERSION" >/tmp/dsh.log 2>&1; then ck "dsh@$DSH_VERSION 装上" 1; else ck "dsh@$DSH_VERSION 装上" 0 "$(tail -2 /tmp/dsh.log)"; fi
echo "  dsh --version → $(dsh --version 2>&1 | tail -1)"

echo
echo "--- 安装插件（真实 tarball）---"
TGZ=$(ls /art/*.tgz | head -1)
echo "  $(basename "$TGZ")  $(du -h "$TGZ" | cut -f1)"
if dsh plugin --profile web add "$TGZ" >/tmp/add.log 2>&1; then ck "dsh plugin add 成功" 1; else ck "dsh plugin add 成功" 0 "$(tail -3 /tmp/add.log)"; fi

echo
echo "--- 装后（未启动）：组成里出现本插件的行 ---"
dsh --profile web --dump-config >/tmp/dump.txt 2>&1
grep -q "quant-host" /tmp/dump.txt && ck "组成含 quant-host 行" 1 || ck "组成含 quant-host 行" 0
grep -q "dsh-quant-assistant" /tmp/dump.txt && ck "组成含包名" 1 || ck "组成含包名" 0
# 这一条是**预期为真**的：安装本身不物化 preset（物化发生在首次启动的 apply 里）
[ -d "$PRESET" ] && ck "安装本身不物化 preset（符合预期）" 0 "不该在 add 时就出现" || ck "安装本身不物化 preset（符合预期）" 1

echo
echo "--- 首次启动：起 web 并取 index ---"
( timeout 120 dsh web --port 0 --no-open >/tmp/web.log 2>&1 & ) ; sleep 50
cat > /tmp/probe.mjs <<'PROBEEOF'
import { readFileSync } from 'node:fs'
const log = readFileSync('/tmp/web.log', 'utf8')
const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/)
if (!m) { console.log('WEBLOG_BEGIN'); console.log(log); console.log('WEBLOG_END'); process.exit(1) }
const [, port, token] = m
const r1 = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })
const cookie = (r1.headers.getSetCookie?.() ?? [r1.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).join('; ')
const r2 = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })
const html = await r2.text()
const hasClient = html.includes('dsh-quant-assistant/client.js')
console.log(`  web 起来了：${m[0]}`)
console.log(`  index ${r2.status} ${html.length} 字节；客户端模块在清单里：${hasClient}`)
process.exit(hasClient ? 0 : 1)
PROBEEOF
HOST_BROKEN=0
if node /tmp/probe.mjs; then
  ck "web 能起来且客户端模块已注册进 index" 1
else
  # **分辨"宿主自己起不来"与"本插件让它起不来"**：
  # 实测 @deepseek-ai/dsh@0.1.5-rc.1 的 npm 发布里，dsh-base 要求 dsh-sandbox-local@^0.1.5-rc.2，
  # 而该包只发布了 0.0.1-rc.1 与 0.2.x —— **没有任何版本满足**，npm 直接跳过，
  # 于是组成里的 sandbox 行解析不了，干净装出来的 DSH 根本起不来（0.2.0-rc.2 正常）。
  # 这不是本插件的问题，所以后面的依赖项要报"跳过"而不是"失败"。
  if grep -q "sandbox-local" /tmp/web.log; then
    HOST_BROKEN=1
    skip "web 能起来且客户端模块已注册进 index" "宿主打包缺口：$DSH_VERSION 的 dsh-sandbox-local 无可解析版本（与插件无关）"
  else
    ck "web 能起来且客户端模块已注册进 index" 0
  fi
fi

echo
echo "--- 启动后：preset 与技能被物化 ---"
if [ "$HOST_BROKEN" = "1" ]; then
  skip "preset.yml / agent.cordis.yml / 四个技能 / 元数据" "宿主起不来，apply 没机会执行"
else
  [ -f "$PRESET/preset.yml" ] && ck "preset.yml 已投递" 1 || ck "preset.yml 已投递" 0
  [ -f "$PRESET/agent.cordis.yml" ] && ck "agent.cordis.yml 已投递" 1 || ck "agent.cordis.yml 已投递" 0
  n=$(ls "$PRESET/skills" 2>/dev/null | wc -l)
  [ "$n" = "4" ] && ck "四个技能已投递" 1 || ck "四个技能已投递" 0 "实际 $n"
  [ -f "$PRESET/.installed-by-dsh-quant.json" ] && ck "元数据已写入" 1 || ck "元数据已写入" 0
fi

echo
echo "--- 启动后：preset 引用的每个包都能解析（否则 preset 挂不起来）---"
cat > /tmp/refs.mjs <<'REFEOF'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const req = createRequire(import.meta.url)
const src = readFileSync(process.env.HOME + '/.dsh/.agent-presets/quant-assistant/agent.cordis.yml', 'utf8')
const uniq = [...new Set([...src.matchAll(/name:\s*'(@[^']+)'/g)].map((m) => m[1]))]
// 解析根必须包含 **dsh 自己的安装树**：bundle（dsh-base / dsh-web-app 等）不在 profile 的
// node_modules 里，profile 只装第三方插件；DSH 从全局安装树解析它们。
// 第一版只给了 profile 路径，于是把"解析不了"误报成插件的错（实测 profile 的
// .dsh-module-fallback/node_modules 是空的，证明那条路不是解析路径）。
const gRoot = execSync('npm root -g').toString().trim()
const dshRoot = gRoot + '/@deepseek-ai/dsh'
const paths = [dshRoot, dshRoot + '/node_modules', process.env.HOME + '/.dsh/profiles/web']
const miss = uniq.filter((r) => { try { req.resolve(r, { paths }); return false } catch { return true } })
console.log(`  引用 ${uniq.length} 个包，无法解析 ${miss.length}${miss.length ? ' → ' + miss.join(', ') : ''}`)
process.exit(miss.length ? 1 : 0)
REFEOF
if [ "$HOST_BROKEN" = "1" ]; then
  skip "preset 引用的包全部可解析" "preset 未物化（宿主起不来）"
else
  node /tmp/refs.mjs && ck "preset 引用的包全部可解析" 1 || ck "preset 引用的包全部可解析" 0
fi
pkill -f "dsh web" 2>/dev/null

echo
echo "--- 建一个数据仓库（验证卸载后数据是否保留）---"
node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const dir = process.env.HOME + "/.dsh/quant";
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(dir + "/quant.db");
db.exec("CREATE TABLE IF NOT EXISTS probe(x INTEGER)");
db.exec("INSERT INTO probe VALUES (1)");
db.close();
console.log("  仓库已建：" + dir + "/quant.db");
' 2>/dev/null
[ -f "$DSH_HOME/quant/quant.db" ] && ck "数据仓库已建立" 1 || ck "数据仓库已建立" 0

echo
echo "--- 卸载 ---"
if dsh plugin --profile web remove dsh-quant-assistant >/tmp/rm.log 2>&1; then ck "dsh plugin remove 成功" 1; else ck "dsh plugin remove 成功" 0 "$(tail -3 /tmp/rm.log)"; fi

dsh --profile web --dump-config >/tmp/dump2.txt 2>&1
grep -q "quant-host" /tmp/dump2.txt && ck "组成里不再有 quant-host 行" 0 || ck "组成里不再有 quant-host 行" 1
grep -q "dsh-quant-assistant" "$PROFILE/package.json" 2>/dev/null && ck "profile 依赖已移除" 0 || ck "profile 依赖已移除" 1
[ -d "$PRESET" ] && ck "preset 目录已清理" 0 || ck "preset 目录已清理" 1
[ -f "$DSH_HOME/quant/quant.db" ] && ck "数据按策略保留（默认不删）" 1 || ck "数据按策略保留（默认不删）" 0
if dsh --profile web --dump-config >/dev/null 2>&1; then ck "卸载后组成仍可解析（配置未损坏）" 1; else ck "卸载后组成仍可解析（配置未损坏）" 0; fi

echo
echo "=== 容器内结果：通过 $pass / 失败 $fail${skipped:+ / 跳过 $skipped} ==="
if [ "$HOST_BROKEN" = "1" ]; then
  echo "  ⚠️  宿主 $DSH_VERSION 自身装不起来（npm 发布的 dsh-sandbox-local 无可解析版本）；"
  echo "      依赖启动的检查已标记为跳过，不算本插件的失败。"
fi
[ "$fail" = "0" ] || exit 1
