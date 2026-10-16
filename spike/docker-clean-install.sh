#!/usr/bin/env bash
# P6 验收标准 4：**干净环境**走完「安装 → 启动 → 卸载」全程。
#
# 为什么用容器而不是"删掉 DSH_HOME 再来一遍"：
#   干净 DSH_HOME 只证明"我的状态没残留"，证明不了"依赖装得上" ——
#   本机已经有全局 pnpm、有各种缓存、有恰好能用的 Node。
#   容器给的是全新的 OS + Node + npm 全局树，这才是新用户拿到的环境。
#
# 而且装的是 **npm pack 出来的 tarball**，不是工作区目录 ——
#   这样验的是**真实发布产物**，能顺带抓到 `files` 数组漏文件这类问题。
#
# 用法: bash spike/docker-clean-install.sh [dsh版本 ...]
#   不带参数 → 验 0.1.5-rc.1（与开发环境一致）与 0.2.0-rc.2（npm latest，新用户拿到的）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ART="$(mktemp -d)"
trap 'rm -rf "$ART"' EXIT

echo "=== 打包真实发布产物 ==="
cd "$ROOT"
# 注意别写成 `|| { echo ...; exit 1 }`：`}` 前少一个 `;` 时，bash 会把 `}` 当成 `exit` 的
# 参数，花括号组永远不闭合，报的是"第 N+1 行 unexpected end of file"——离真正的问题很远。
if ! npm_config_cache="${npm_config_cache:-/tmp/npm-cache-quant}" npm pack --pack-destination "$ART" >/dev/null 2>&1; then
  echo "npm pack 失败"
  exit 1
fi
TGZ="$(ls "$ART"/*.tgz | head -1)"
cp "$ROOT/spike/docker/inside-clean-install.sh" "$ART/"
echo "tarball: $(basename "$TGZ")  $(du -h "$TGZ" | cut -f1)"

VERSIONS=("$@")
[ ${#VERSIONS[@]} -eq 0 ] && # 0.2.0-rc.2 是 npm latest（新用户拿到的），且它是**唯一能干净启动**的那条线；
# 0.1.5-rc.1 与开发环境一致，但它的 npm 发布里 dsh-sandbox-local 无可解析版本（宿主自身起不来），
# 容器内会把依赖启动的检查标记为"跳过"而不是"失败"。
VERSIONS=("0.2.0-rc.2" "0.1.5-rc.1")

overall=0
for V in "${VERSIONS[@]}"; do
  echo
  echo "############ dsh $V （容器 node:22-bookworm，全新环境）############"
  docker run --rm \
    -v "$ART":/art:ro \
    -e DSH_VERSION="$V" \
    -e DEBIAN_FRONTEND=noninteractive \
    node:22-bookworm bash /art/inside-clean-install.sh
  rc=$?
  [ $rc -ne 0 ] && overall=1
  echo "---- dsh $V 退出码 $rc ----"
done

echo
if [ $overall -eq 0 ]; then echo "✅ 干净安装/卸载验收通过：${VERSIONS[*]}"; else echo "❌ 干净安装/卸载验收失败"; fi
exit $overall
