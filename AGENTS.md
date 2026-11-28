# AGENTS.md —— 给后续维护者的入口

> 人类请读 [README](./README.md)。本文件只回答两件事：**你在改哪一块、忘了哪一条会静默出错。**

---

## 零、先读这条：不要重启 magpie

`127.0.0.1:3425` 这个网关就是 magpie 进程本身。停它一次，所有模型请求立刻全断。

改完怎么生效：改代码 → `node --test` 全绿 → `git commit` → `git push` → 在 magpie 插件管理里点「更新」。

---

## 一、目录地图

| 路径 | 负责什么 |
|---|---|
| `index.mjs` | 组装层：用 `vendor/qoder.mjs` 的 `makePlugin(site)` 产出对象，再补 `usage` / `icon` / `methods` / `options` / `import` |
| `vendor/qoder.mjs` | **受管第三方拷贝**：登录、模型目录、协议。改动要在文件头记下来，重新同步时带回去 |
| `methods.mjs` | 界面开关与「粘贴 token」登录方式 |
| `import.mjs` | `auth.import`（从文件导入） |
| `test/` | `node --test` 用例 |

---

## 二、会静默出错的坑

| # | 症状 | 判据 |
|---|---|---|
| 1 | 卡片少一块且不报错 | `auth` 必须有 `provider` / `methods` / `usage`；缺了就少 UI |
| 2 | 模型回退被当成本地计划 | 失败列表必须打 `Symbol.for("magpie.fellBack")` |
| 3 | 开关拨了没反应 | `input.magpie.option()` **必须惰性读**，工厂期读恒为 false |
| 4 | 额度算成 0 | `Number(null) === 0` 的坑：缺失值必须保持 `undefined` |

---

## 三、测试

```bash
node --test
```

测试不连真实网络。

---

## 四、交付

推 tag 后在 magpie 插件管理点「更新」。**不重启 magpie。**
