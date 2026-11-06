## 特别鸣谢
https://github.com/LloydAsp/nfd
https://github.com/3915610/PMBOT

---



# 🤖 PM 机器人托管平台 (PM Bot Platform)

基于NFD项目二开加了人机验证

📖 项目简介

CM Bot Platform 是一个功能强大且完全免费的 Telegram 机器人托管解决方案。它允许任何用户通过简单的 Token 提交，一键部署属于自己的私聊转发机器人。

该项目基于 Cloudflare Workers 的无服务器架构构建，无需购买 VPS，无需维护服务器，且具有极高的稳定性和响应速度。它是 Livegram Bot 的完美替代品，去除了烦人的广告。

---

# 部署流程 (Strict Order)

为了确保一次成功，请严格按照以下顺序进行操作：

---

## 第一步：基础准备 (Prerequisites)

1. 注册 Cloudflare：访问 https://dash.cloudflare.com 并完成账号注册。  
2. 获取 Bot Token：在 Telegram 找 @BotFather 创建新机器人，记下 Bot Token（格式类似 123456:ABC...）。  
3. 获取 User ID：在 Telegram 找 @userinfobot 获取你的数字 ID（例如 123456789）。

---

## 第二步：配置 Turnstile (Anti-Spam)

1. 在 Cloudflare 仪表盘中打开 Turnstile -> Add Site。  
2. Domain：填写 workers.dev（或者你要绑定的自定义域名）。  
3. Widget Mode：选择 `Managed`。  
4. 创建后复制并保存 Site Key 和 Secret Key（后面会用到）。

---

## 第三步：创建 Worker (Create Worker)

1. 进入 Cloudflare 的 **Workers & Pages**。  
2. 点击 **Create Application** -> **Create Worker**。  
3. 给 Worker 起个名字（例如 `pm-bot`），然后点击 **Deploy**（此时部署的是默认的 "Hello World" 代码，可以先不管它）。

---

## 第四步：配置环境变量 (Configure Variables) —— 关键步骤！

先不要改代码，先做这一步！

1. 打开刚才创建的 Worker，进入详情页。  
2. 点击顶部的 **Settings (设置)** -> **Variables (变量)**。  
3. 点击 **Edit Variables** -> **Add Variable**，依次添加以下变量：

| 变量名 | 值（示例） | 说明 |
|---|---:|---|
| `ENV_BOT_TOKEN` | `123456:ABC...` | 你的 Bot Token |
| `ENV_BOT_SECRET` | `a5feefbf-a8c1-4ba1-89ed-4ac0b2a3223a` | 自定义密钥（随便填，只要与代码中的预期一致） |
| `ENV_ADMIN_UID` | `123456789` | 你的 User ID |
| `ENV_TURNSTILE_SITE_KEY` | `0x4AAAA...` | Turnstile Site Key |
| `ENV_TURNSTILE_SECRET_KEY` | `0x4AAAA...` | Turnstile Secret Key |

4. 绑定 KV 数据库（非常重要）：
   - 在 Variables 页面向下拉，找到 **KV Namespace Bindings**。  
   - 点击 **Add Binding**。  
   - `Variable name`：填写 `PMBOT`（必须大写，必须完全一致）。  
   - `KV Namespace`：选择你创建好的 KV 空间（如果没有，请先在左侧菜单 **KV** 里创建一个）。  
   - 点击 **Save and Deploy** 保存变量绑定。

> 注意：务必先在 Worker 的变量里配置好以上所有变量并保存，再进行下一步修改代码！这一步顺序不能颠倒。

---

## 第五步：部署代码 (Deploy Code)

1. 回到 Worker 页面，点击右上角的 **Edit code**。  
2. 全选并删除编辑器里原有的代码。  
3. 将我提供给你的 v4.1.1 完整代码 粘贴进去。  
4. 点击右上角的 **Deploy** 将代码部署到 Worker。

---

## 第六步：注册 Webhook (Register)

这是最后一步，激活机器人：

在浏览器地址栏输入（替换为你的 Worker 域名）：
```
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/endpoint&secret_token=<你的ENV_BOT_SECRET>
https://<你的Worker域名>/registerWebhook
```

如果返回 JSON 并且看到 `{"ok": true, ...}`，恭喜你，部署成功并已注册 Webhook！

---

## ✅ 验证测试

1. 用你的主号给机器人发送 `/start`，应该能看到欢迎语和面板。  
2. 用另一个小号（非管理员）发送 `/start`，应该能看到验证提示（Turnstile 验证或其他防刷流程）。

---

## 常见问题 & 注意事项

- 变量名必须完全按上面填写（尤其是 `PMBOT` 的 KV 绑定必须大写）。  
- 先配置变量并保存，再粘贴/部署代码；如果反过来，代码可能读取不到变量导致失败。  
- 如果没有 Turnstile key，请回到 Cloudflare -> Turnstile 生成并复制到 Worker 变量中。  
- 若部署后仍无法工作，检查 Worker 日志（Worker 控制台）查看错误详情。  
- 如果使用自定义域，请确保 DNS 与 Worker 的绑定配置正确，并使用对应域名替换 `workers.dev` 示例。
