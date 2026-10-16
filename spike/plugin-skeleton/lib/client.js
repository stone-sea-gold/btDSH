/**
 * P0-G4 spike — 浏览器半。
 *
 * 实测到的客户端契约（不是普通 ESM）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 *   模块导出 Cordis 插件的 { apply, inject }；裸 require 由模块系统解析（react 等由内核提供）。
 * 结论：这种格式可以手写，不依赖 DSH 单体仓库的构建管线。
 */
window.__ModuleLoader__.load({
  id: '@dsh-spike/quant-skeleton',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'quant-skeleton', label: '量化助手（P0 骨架）' },
          () =>
            React.createElement(
              'div',
              { style: { padding: '16px', lineHeight: 1.6 } },
              React.createElement('strong', null, 'dsh-quant P0 skeleton'),
              React.createElement('p', null, '若你能看到这一页，说明客户端插件包（手写 ModuleLoader 格式）已被正确加载。'),
            ),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
