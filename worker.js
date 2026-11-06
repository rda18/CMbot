/**
 * CM Bot Platform - Optimized Worker (每条消息均发送访客资料卡)
 * * 修复说明：
 * 之前的验证 Key 是 `verified-{uid}` (全局共享)。
 * 现在改为 `verified-{routeId}-{uid}` (每个机器人独立)。
 * 这样新创建的机器人不会继承用户在旧机器人上的验证状态。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. 主机器人 Webhook (平台入口)
    if (url.pathname === '/endpoint') {
      return handleMainBotWebhook(request, env, ctx);
    } 
    // 2. 托管机器人入口 (子机器人)
    else if (url.pathname.startsWith('/entry/')) {
      const routeId = url.pathname.split('/')[2];
      return handleManagedBotWebhook(request, env, ctx, routeId);
    }
    // 3. 注册主机器人 Webhook
    else if (url.pathname === '/registerWebhook') {
      return registerMainWebhook(request, url, env);
    } 
    // 4. 人机验证页面
    else if (url.pathname === '/verify') {
      return handleVerifyPage(url, env);
    } 
    // 5. 人机验证提交接口
    else if (url.pathname === '/verify_submit') {
      return handleVerifySubmit(request, env);
    } 
    else {
      return new Response('PM Bot Platform Running (v4.1 - Minimal Detailed Guest UI)...');
    }
  }
};

// --- 配置区域 ---
const NOTIFY_INTERVAL = 3600 * 1000; 
const fraudDbUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const DEFAULT_TTL = 30 * 24 * 60 * 60;

// KV 是最终一致性存储。下面的内存缓存用于同一 Worker isolate 内快速命中；
// 它是加速层，不是持久化层，也不能保证跨地区强一致。
const verifiedMemory = new Map();
const pendingVerifyMemory = new Map();
let fraudDbMemory = { value: null, expiresAt: 0 };
const MEMORY_CACHE_MAX = 5000;

function memorySet(map, key, value) {
  if (map.size >= MEMORY_CACHE_MAX && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
}

function verifiedKey(routeId, uid) {
  return `verified-${routeId}-${uid}`;
}

async function isGuestVerified(env, routeId, uid) {
  const key = verifiedKey(routeId, uid);
  const now = Date.now();
  const cached = verifiedMemory.get(key);
  if (cached && cached.expiresAt > now) return true;
  if (cached) verifiedMemory.delete(key);

  // 将 KV 默认边缘缓存时间明确设为 30 秒，避免默认 60 秒负缓存窗口。
  // 注意：这仍不能消除 KV 跨地区写入传播延迟。
  const value = await env.PMBOT.get(key, { cacheTtl: 30 });
  const verified = value === 'true' || value === '1';
  if (verified) memorySet(verifiedMemory, key, { expiresAt: now + 5 * 60 * 1000 });
  return verified;
}

async function getFraudDatabase() {
  const now = Date.now();
  if (fraudDbMemory.value && fraudDbMemory.expiresAt > now) return fraudDbMemory.value;
  const response = await fetch(fraudDbUrl, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new Error(`Fraud database HTTP ${response.status}`);
  const value = await response.text();
  fraudDbMemory = { value, expiresAt: now + 60 * 60 * 1000 };
  return value;
}

// --- [文案配置] 子机器人管理员使用教程 ---
const OWNER_HELP_TEXT = `
👋 **管理员您好！**

您的私聊机器人正在运行中。

📝 **如何使用？**

1. **接收消息**
   当有人给此机器人发消息时，您会立刻收到转发。

2. **回复用户**
   直接**回复 (左滑消息)** 转发过来的消息，即可发送文字给对方。

3. **管理用户**
   • **屏蔽/解封**：点击消息下方的按钮，或回复 \`/block\` / \`/unblock\`。
   • **查看资料**：点击消息下方的用户昵称。

💡 *提示：所有新用户在第一次联系您时，都需要通过人机验证，有效拦截广告。*
`;

// --- 辅助函数 ---
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function apiUrl(method, token, params = null) {
  let query = params ? '?' + new URLSearchParams(params).toString() : '';
  return `https://api.telegram.org/bot${token}/${method}${query}`;
}

async function requestTelegram(method, token, body) {
  const resp = await fetch(apiUrl(method, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function sendMessage(token, chatId, text, options = {}) {
  return requestTelegram('sendMessage', token, {
    chat_id: chatId,
    text: text,
    ...options
  });
}

// [核心] 自动设置机器人菜单命令
async function setBotCommands(token) {
  return requestTelegram('setMyCommands', token, {
    commands: [
      { command: 'start', description: '开始使用 / 查看教程' }
    ]
  });
}

async function copyMessage(token, toChatId, fromChatId, messageId, options = {}) {
  return requestTelegram('copyMessage', token, {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...options
  });
}

async function forwardMessage(token, toChatId, fromChatId, messageId) {
  return requestTelegram('forwardMessage', token, {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId
  });
}

async function answerCallbackQuery(token, callbackQueryId, text = null, showAlert = false) {
  return requestTelegram('answerCallbackQuery', token, {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  });
}

async function editMessageText(token, chatId, messageId, text, options = {}) {
  return requestTelegram('editMessageText', token, {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    ...options
  });
}

// ==================================================
// 1. 主机器人逻辑 (平台入口)
// ==================================================

async function handleMainBotWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.ENV_BOT_SECRET) {
    return new Response('Unauthorized', { status: 403 });
  }
  
  const update = await request.json();
  const MAIN_TOKEN = env.ENV_BOT_TOKEN;
  const ADMIN_ID = env.ENV_ADMIN_UID; 

  // --- 处理回调查询 ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data;
    const chatId = cq.message.chat.id;

    if (chatId.toString() !== ADMIN_ID) {
        await answerCallbackQuery(MAIN_TOKEN, cq.id, "无权操作", true);
        return new Response('Ok');
    }

    let platformConfig = await env.PMBOT.get('platform:settings', { type: 'json' }) || {
        enable_new_users: true,
        verify_ttl: DEFAULT_TTL
    };

    if (data === 'admin_toggle_access') {
        platformConfig.enable_new_users = !platformConfig.enable_new_users;
        await env.PMBOT.put('platform:settings', JSON.stringify(platformConfig));
        const dashboard = await getAdminDashboardUI(platformConfig, env);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, dashboard.text, { parse_mode: 'Markdown', reply_markup: dashboard.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id, `新接入已${platformConfig.enable_new_users ? '开启' : '关闭'}`);
    }
    else if (data === 'admin_ttl_menu') {
        const ttlMenu = getTTLMenuUI(platformConfig.verify_ttl); 
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, ttlMenu.text, { parse_mode: 'Markdown', reply_markup: ttlMenu.markup });
    }
    else if (data.startsWith('admin_set_ttl_')) {
        const days = parseInt(data.split('_')[3]);
        platformConfig.verify_ttl = days * 24 * 60 * 60;
        await env.PMBOT.put('platform:settings', JSON.stringify(platformConfig));
        await answerCallbackQuery(MAIN_TOKEN, cq.id, "设置已更新");
        const dashboard = await getAdminDashboardUI(platformConfig, env);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, dashboard.text, { parse_mode: 'Markdown', reply_markup: dashboard.markup });
    }
    else if (data === 'admin_users') {
        const page = await getManagedOwnersUI(env, 0);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data === 'admin_guests') {
        const page = await getGuestRoutesUI(env, 0);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data === 'admin_search_owner' || data === 'admin_search_guest') {
        await env.PMBOT.put(`admin:state:${ADMIN_ID}`, data === 'admin_search_owner' ? 'search_owner' : 'search_guest', { expirationTtl: 600 });
        await sendMessage(MAIN_TOKEN, chatId, data === 'admin_search_owner' ? '🔍 请发送 Telegram UID 或机器人用户名进行搜索：' : '🔍 请发送访客 Telegram UID 或 Route ID 进行搜索：');
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_owner_page_')) {
        const pageNo = Math.max(0, parseInt(data.split('_').pop()) || 0);
        const page = await getManagedOwnersUI(env, pageNo);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_guest_routes_')) {
        const pageNo = Math.max(0, parseInt(data.split('_').pop()) || 0);
        const page = await getGuestRoutesUI(env, pageNo);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_route_')) {
        const routeId = data.slice('admin_route_'.length);
        const page = await getRouteDetailUI(env, routeId);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_pause_') || data.startsWith('admin_resume_')) {
        const pause = data.startsWith('admin_pause_');
        const routeId = data.slice(pause ? 'admin_pause_'.length : 'admin_resume_'.length);
        const raw = await env.PMBOT.get(`platform:route:${routeId}`);
        if (raw) {
            const cfg = JSON.parse(raw); cfg.paused = pause;
            await env.PMBOT.put(`platform:route:${routeId}`, JSON.stringify(cfg));
            await answerCallbackQuery(MAIN_TOKEN, cq.id, pause ? '机器人已暂停' : '机器人已恢复', true);
        } else await answerCallbackQuery(MAIN_TOKEN, cq.id, '机器人记录不存在', true);
        const page = await getRouteDetailUI(env, routeId);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
    }
    else if (data.startsWith('admin_ban_owner_') || data.startsWith('admin_unban_owner_')) {
        const ban = data.startsWith('admin_ban_owner_');
        const uid = data.slice(ban ? 'admin_ban_owner_'.length : 'admin_unban_owner_'.length);
        if (ban) await env.PMBOT.put(`platform:banned:${uid}`, '1');
        else await env.PMBOT.delete(`platform:banned:${uid}`);
        await answerCallbackQuery(MAIN_TOKEN, cq.id, ban ? '已禁止该用户接入' : '已恢复该用户接入', true);
        const page = await getOwnerDetailUI(env, uid);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
    }
    else if (data.startsWith('admin_owner_')) {
        const uid = data.slice('admin_owner_'.length);
        const page = await getOwnerDetailUI(env, uid);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_guests_for_')) {
        const routeId = data.slice('admin_guests_for_'.length);
        const page = await getRouteGuestsUI(env, routeId, 0);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_guest_page_')) {
        const m = data.match(/^admin_guest_page_(.+)_(\d+)$/); const routeId = m ? m[1] : ''; const pageNo = m ? Math.max(0, parseInt(m[2]) || 0) : 0;
        const page = await getRouteGuestsUI(env, routeId, pageNo);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('agd_')) {
        const m = data.match(/^agd_(.+)_(-?\d+)$/); const routeId = m ? m[1] : ''; const guestId = m ? m[2] : '';
        const page = await getGuestDetailUI(env, routeId, guestId);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('agb_') || data.startsWith('agu_')) {
        const block = data.startsWith('agb_');
        const m = data.match(/^ag[bu]_(.+)_(-?\d+)$/); const routeId = m ? m[1] : ''; const guestId = m ? m[2] : '';
        const key = `isblocked-${routeId}-${guestId}`;
        if (block) await env.PMBOT.put(key, 'true'); else await env.PMBOT.delete(key);
        await answerCallbackQuery(MAIN_TOKEN, cq.id, block ? '访客已屏蔽' : '访客已解封', true);
        const page = await getGuestDetailUI(env, routeId, guestId);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
    }
    else if (data.startsWith('admin_delete_') && !data.startsWith('admin_delete_confirm_')) {
        const routeId = data.slice('admin_delete_'.length);
        await env.PMBOT.put(`admin:confirm_delete:${ADMIN_ID}`, routeId, { expirationTtl: 120 });
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, `⚠️ <b>确认删除机器人？</b>\nRoute：<code>${escapeHtml(routeId)}</code>\n这会删除该机器人配置及访客索引，并尝试移除 Telegram Webhook。`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{text:'确认删除',callback_data:`admin_delete_confirm_${routeId}`}],[{text:'取消',callback_data:`admin_route_${routeId}`}]] } });
        await answerCallbackQuery(MAIN_TOKEN, cq.id);
    }
    else if (data.startsWith('admin_delete_confirm_')) {
        const routeId = data.slice('admin_delete_confirm_'.length);
        const confirmed = await env.PMBOT.get(`admin:confirm_delete:${ADMIN_ID}`);
        if (confirmed !== routeId) { await answerCallbackQuery(MAIN_TOKEN, cq.id, '确认已过期，请重新操作', true); }
        else {
            await deleteManagedRoute(env, routeId);
            await env.PMBOT.delete(`admin:confirm_delete:${ADMIN_ID}`);
            await answerCallbackQuery(MAIN_TOKEN, cq.id, '机器人已删除', true);
        }
        const page = await getManagedOwnersUI(env, 0);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
    }
    else if (data === 'admin_refresh') {
        const dashboard = await getAdminDashboardUI(platformConfig, env);
        await editMessageText(MAIN_TOKEN, chatId, cq.message.message_id, dashboard.text, { parse_mode: 'Markdown', reply_markup: dashboard.markup });
        await answerCallbackQuery(MAIN_TOKEN, cq.id, "已刷新");
    }

    return new Response('Ok');
  }

  // --- 处理消息 ---
  if (!update.message) return new Response('Ok');
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // 超级管理员搜索输入状态（仅管理员私聊有效）
  if (chatId.toString() === ADMIN_ID) {
    const adminState = await env.PMBOT.get(`admin:state:${ADMIN_ID}`);
    if (adminState && text && !text.startsWith('/')) {
      await env.PMBOT.delete(`admin:state:${ADMIN_ID}`);
      const page = adminState === 'search_owner' ? await searchOwnersUI(env, text.trim()) : await searchGuestsUI(env, text.trim());
      await sendMessage(MAIN_TOKEN, chatId, page.text, { parse_mode: 'HTML', reply_markup: page.markup });
      return new Response('Ok');
    }
  }

  if (text === '/start') {
      if (chatId.toString() === ADMIN_ID) {
          let platformConfig = await env.PMBOT.get('platform:settings', { type: 'json' }) || {
            enable_new_users: true,
            verify_ttl: DEFAULT_TTL
          };
          const dashboard = await getAdminDashboardUI(platformConfig, env);
          await sendMessage(MAIN_TOKEN, chatId, dashboard.text, { 
              parse_mode: 'Markdown',
              reply_markup: dashboard.markup
          });
      } else {
          const welcomeMsg = `
🤖 **欢迎使用 PM 机器人托管平台**

在这里，您可以免费创建一个功能强大的**私聊转发机器人**。
它能帮您接收陌生人的消息，隐藏您的真实身份，并自动拦截垃圾广告。

🌟 **核心功能：**
• **智能验证**：自动拦截机器人和广告骚扰。
• **隐私回复**：直接回复消息，对方看不到您的账号。
• **一键管理**：消息下方自带屏蔽/解封按钮。
• **数据统计**：查看有多少人联系过您。

🚀 **如何开始？**
只需将您的 **Bot Token** 发送给我即可。
*(如果您还没有 Token，请先找 @BotFather 申请一个)*
          `;
          await sendMessage(MAIN_TOKEN, chatId, welcomeMsg, { parse_mode: 'Markdown' });
      }
      return new Response('Ok');
  }

  if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(text.trim())) {
    if (chatId.toString() !== ADMIN_ID && await env.PMBOT.get(`platform:banned:${chatId}`)) {
      await sendMessage(MAIN_TOKEN, chatId, '⛔️ 您当前没有创建托管机器人的权限。如有疑问请联系平台管理员。');
      return new Response('Ok');
    }
    const platformConfig = await env.PMBOT.get('platform:settings', { type: 'json' }) || { enable_new_users: true };
    
    if (!platformConfig.enable_new_users && chatId.toString() !== ADMIN_ID) {
        await sendMessage(MAIN_TOKEN, chatId, '⛔️ **平台维护中**\n\n管理员已暂时关闭新机器人接入，请稍后再试。', { parse_mode: 'Markdown' });
        return new Response('Ok');
    }

    const userToken = text.trim();
    await sendMessage(MAIN_TOKEN, chatId, '⏳ 正在验证 Token 并部署环境，请稍候...');

    const verifyResp = await fetch(apiUrl('getMe', userToken)).then(r => r.json());
    if (!verifyResp.ok) {
      await sendMessage(MAIN_TOKEN, chatId, '❌ **Token 无效**\n请检查是否复制完整。', { parse_mode: 'Markdown' });
      return new Response('Ok');
    }
    
    const botUsername = verifyResp.result.username;
    let routeId = uuidv4();
    const workerOrigin = new URL(request.url).origin;
    const webhookUrl = `${workerOrigin}/entry/${routeId}`;
    const secret = uuidv4();

    const setHookResp = await fetch(apiUrl('setWebhook', userToken, { 
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: JSON.stringify(["message", "callback_query"]) 
    })).then(r => r.json());

    if (!setHookResp.ok) {
      await sendMessage(MAIN_TOKEN, chatId, `❌ **部署失败**: ${setHookResp.description}`);
      return new Response('Ok');
    }
    
    // [自动设置菜单]
    await setBotCommands(userToken);

    const botConfig = {
      token: userToken,
      owner_id: chatId,
      secret: secret,
      bot_username: botUsername,
      created_at: Date.now(),
      enable_verify: true,
      paused: false
    };

    await env.PMBOT.put(`platform:route:${routeId}`, JSON.stringify(botConfig));
    // 新增按用户-机器人关系索引；保留旧 platform:user:{uid} 键供旧数据兼容
    await env.PMBOT.put(`platform:owner:${chatId}:route:${routeId}`, '1');
    const ownerKey = `platform:user:${chatId}`;
    const ownerRaw = await env.PMBOT.get(ownerKey, { type: 'json' });
    const oldRoutes = ownerRaw ? (Array.isArray(ownerRaw.routes) ? ownerRaw.routes : (ownerRaw.routeId ? [ownerRaw.routeId] : [])) : [];
    if (!oldRoutes.includes(routeId)) oldRoutes.push(routeId);
    await env.PMBOT.put(ownerKey, JSON.stringify({ owner_id: chatId, routes: oldRoutes, routeId: oldRoutes[0] || routeId, token: botConfig.token, bot_username: botConfig.bot_username, created_at: botConfig.created_at }));
    
    const totalBotsKey = 'stats:platform:total_bots';
    ctx.waitUntil((async () => {
        let currentTotal = await env.PMBOT.get(totalBotsKey) || 0;
        await env.PMBOT.put(totalBotsKey, parseInt(currentTotal) + 1);
    })());

    const safeBotUsername = botUsername.replace(/_/g, '\\_');

    const successMsg = `
✅ **部署成功！**

您的私聊机器人已就绪：@${safeBotUsername}

👉 **下一步**：
请直接前往您的机器人，点击左下角 **菜单** 或发送 **/start** 开始使用。
    `;
    await sendMessage(MAIN_TOKEN, chatId, successMsg, { parse_mode: 'Markdown' });

    // [自动发送欢迎语]
    try {
        await sendMessage(userToken, chatId, OWNER_HELP_TEXT, { parse_mode: 'Markdown' });
    } catch (e) {
        // 忽略首次发送可能失败的情况
    }

    return new Response('Ok');
  }

  return new Response('Ok');
}

// ==================================================
// 2. 托管机器人逻辑 (Bot Owner & Guest)
// ==================================================

async function handleManagedBotWebhook(request, env, ctx, routeId) {
  if (!routeId || !/^[A-Za-z0-9-]{8,80}$/.test(routeId)) {
    return new Response('Invalid route', { status: 400 });
  }

  const configStr = await env.PMBOT.get(`platform:route:${routeId}`, { cacheTtl: 30 });
  if (!configStr) return new Response('Bot not found', { status: 404 });

  let config;
  try { config = JSON.parse(configStr); }
  catch { return new Response('Invalid bot config', { status: 500 }); }
  if (typeof config.enable_verify === 'undefined') config.enable_verify = true;
  if (config.secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== config.secret) {
    return new Response('Unauthorized', { status: 403 });
  }
  if (config.paused) return new Response('Bot paused', { status: 200 });

  const update = await request.json();
  const TOKEN = config.token;
  const OWNER_ID = String(config.owner_id);

  // --- 处理回调查询 ---
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id;
    if (String(chatId) !== OWNER_ID) {
      await answerCallbackQuery(TOKEN, cq.id, '无权操作', true);
      return new Response('Ok');
    }

    if (data.startsWith('block_')) {
      const targetId = data.slice('block_'.length);
      await env.PMBOT.put(`isblocked-${routeId}-${targetId}`, 'true');
      await answerCallbackQuery(TOKEN, cq.id, `🚫 用户 ${targetId} 已屏蔽`, true);
    } else if (data.startsWith('unblock_')) {
      const targetId = data.slice('unblock_'.length);
      await env.PMBOT.delete(`isblocked-${routeId}-${targetId}`);
      await answerCallbackQuery(TOKEN, cq.id, `✅ 用户 ${targetId} 已解封`, true);
    } else if (data === 'reply_placeholder') {
      await answerCallbackQuery(TOKEN, cq.id);
    }
    return new Response('Ok');
  }

  if (!update.message) return new Response('Ok');
  const msg = update.message;
  const chatId = msg.chat.id;
  const chatIdText = String(chatId);
  const text = msg.text || '';

  // === A. 机器人管理员 (Bot Owner) ===
  if (chatIdText === OWNER_ID) {
    if (msg.reply_to_message) {
      // 新映射按 routeId 隔离；同时回退读取旧版全局 Key，兼容已存在的回复记录。
      const newMappingKey = `msg-map-${routeId}-${msg.reply_to_message.message_id}`;
      const oldMappingKey = `msg-map-${msg.reply_to_message.message_id}`;
      const guestChatId = await env.PMBOT.get(newMappingKey) || await env.PMBOT.get(oldMappingKey);

      if (guestChatId) {
        if (text.startsWith('/block')) {
          await env.PMBOT.put(`isblocked-${routeId}-${guestChatId}`, 'true');
          await sendMessage(TOKEN, OWNER_ID, `🚫 已屏蔽用户 ${guestChatId}`);
          return new Response('Ok');
        }
        if (text.startsWith('/unblock')) {
          await env.PMBOT.delete(`isblocked-${routeId}-${guestChatId}`);
          await sendMessage(TOKEN, OWNER_ID, `✅ 已解除屏蔽 ${guestChatId}`);
          return new Response('Ok');
        }
        await copyMessage(TOKEN, guestChatId, chatId, msg.message_id);
        return new Response('Ok');
      }
    }

    if (text === '/start') {
      await sendMessage(TOKEN, chatId, OWNER_HELP_TEXT, { parse_mode: 'Markdown' });
      // 菜单命令不需要阻塞管理员响应。
      ctx.waitUntil(setBotCommands(TOKEN).catch(() => {}));
    }
    return new Response('Ok');
  }

  // === B. 普通访客 (Guest) ===
  // 屏蔽状态并行读取。KV 值统一按字符串处理，兼容旧版 true/false 值。
  const [routeBlocked, legacyBlocked] = await Promise.all([
    env.PMBOT.get(`isblocked-${routeId}-${chatIdText}`, { cacheTtl: 30 }),
    env.PMBOT.get(`isblocked-${chatIdText}`, { cacheTtl: 30 })
  ]);
  const isBlocked = [routeBlocked, legacyBlocked].some(v => v === 'true' || v === '1');
  if (isBlocked) {
    await sendMessage(TOKEN, chatId, '🚫 **您已被管理员屏蔽**', { parse_mode: 'Markdown' });
    return new Response('Ok');
  }

  // /start 仍展示欢迎语，不将 /start 当作验证成功，也不转发给管理员。
  if (text === '/start') {
    const statsKey = `stats:${routeId}:users`;
    ctx.waitUntil((async () => {
      const count = Number(await env.PMBOT.get(statsKey) || 0);
      await env.PMBOT.put(statsKey, String(count + 1));
    })().catch(() => {}));

    const welcome = config.welcome_msg || `
👋 **您好！这里是私聊机器人**

如果您有任何事，请直接发送消息。
我会收到并尽快回复。

⚠️ *请注意：所有消息均会被记录，请勿发送垃圾广告。*
    `;
    await sendMessage(TOKEN, chatId, welcome, { parse_mode: 'Markdown' });
    return new Response('Ok');
  }

  // 验证状态先查 isolate 内存，再查 KV。验证成功后会立即写入本 isolate 缓存。
  if (config.enable_verify) {
    const isVerified = await isGuestVerified(env, routeId, chatIdText);
    if (!isVerified) {
      const pendingKey = `verify:pending:${routeId}:${chatIdText}`;
      const localPending = pendingVerifyMemory.get(pendingKey);
      let pending = localPending && localPending.expiresAt > Date.now() ? localPending : null;
      if (!pending) {
        const pendingRaw = await env.PMBOT.get(pendingKey, { cacheTtl: 30 });
        if (pendingRaw) {
          try { pending = JSON.parse(pendingRaw); } catch {}
        }
      }

      // 已有未过期验证链接时复用同一个 nonce；45 秒内不重复发送验证消息。
      let createdPending = false;
      if (!pending || !pending.nonce || !pending.verifyLink || pending.expiresAt <= Date.now()) {
        const workerOrigin = new URL(request.url).origin;
        const firstName = msg.from?.first_name || 'User';
        const username = msg.from?.username ? `(@${msg.from.username})` : '';
        const verifyNonce = uuidv4();
        const expiresAt = Date.now() + 10 * 60 * 1000;
        const verifyLink = `${workerOrigin}/verify?uid=${encodeURIComponent(chatIdText)}&routeId=${encodeURIComponent(routeId)}&nonce=${encodeURIComponent(verifyNonce)}&name=${encodeURIComponent(firstName)}&user=${encodeURIComponent(username)}`;
        pending = { nonce: verifyNonce, verifyLink, expiresAt, lastSentAt: 0 };
        await env.PMBOT.put(`verify:nonce:${verifyNonce}`, JSON.stringify({ uid: chatIdText, routeId }), { expirationTtl: 600 });
        createdPending = true;
      }

      const shouldSendChallenge = createdPending || !pending.lastSentAt || (Date.now() - pending.lastSentAt > 45 * 1000);
      if (shouldSendChallenge) {
        pending.lastSentAt = Date.now();
        await env.PMBOT.put(pendingKey, JSON.stringify(pending), { expirationTtl: 600 });
        memorySet(pendingVerifyMemory, pendingKey, pending);
        await sendMessage(TOKEN, chatId, '🛡 <b>安全验证 (Security Check)</b>\n\n为了防止垃圾信息，请点击下方框体验证。\nPlease verify you are human to continue.', {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🤖 点击验证 (Verify)', web_app: { url: pending.verifyLink } }]]
          }
        });
      }
      return new Response('Ok');
    }
  }

  // 只有通过验证的普通消息才更新访客资料和转发。
  const guestKey = `platform:guest:${routeId}:${chatIdText}`;
  let guestRecord = await env.PMBOT.get(guestKey, { type: 'json', cacheTtl: 30 });
  const now = Date.now();
  if (!guestRecord) {
    guestRecord = {
      routeId,
      guest_id: chatId,
      first_name: msg.from?.first_name || '',
      last_name: msg.from?.last_name || '',
      username: msg.from?.username || '',
      first_seen: now,
      messages: 0
    };
  }
  guestRecord.first_name = msg.from?.first_name || guestRecord.first_name || '';
  guestRecord.last_name = msg.from?.last_name || guestRecord.last_name || '';
  guestRecord.username = msg.from?.username || guestRecord.username || '';
  guestRecord.last_seen = now;
  guestRecord.messages = Number(guestRecord.messages || 0) + 1;
  // 访客资料写入放到后台，不阻塞消息转发；该计数在并发消息下属于近似统计。
  ctx.waitUntil(env.PMBOT.put(guestKey, JSON.stringify(guestRecord)).catch(() => {}));

  const copyResp = await copyMessage(TOKEN, OWNER_ID, chatId, msg.message_id);
  if (!copyResp || !copyResp.ok || !copyResp.result?.message_id) return new Response('Ok');

  const statsKey = `stats:${routeId}:msgs`;
  ctx.waitUntil((async () => {
    const count = Number(await env.PMBOT.get(statsKey) || 0);
    await env.PMBOT.put(statsKey, String(count + 1));
  })().catch(() => {}));

  // 消息映射增加 routeId，避免不同托管机器人产生相同 message_id 时串线。
  // 同时写入旧 Key，便于旧版流程/数据过渡。
  const mappingTtl = 60 * 60 * 48;
  const mappingValue = String(chatId);
  await Promise.all([
    env.PMBOT.put(`msg-map-${routeId}-${copyResp.result.message_id}`, mappingValue, { expirationTtl: mappingTtl }),
    env.PMBOT.put(`msg-map-${copyResp.result.message_id}`, mappingValue, { expirationTtl: mappingTtl })
  ]);

  // 每条访客消息都发送一张独立资料卡，方便管理员逐条查看和回复。
  // 资料卡发送放在 waitUntil 后台执行，不阻塞 Telegram Webhook 对消息的确认。
  // 每张资料卡都写入独立消息映射，因此回复任意一张卡片都会发回同一访客。
  ctx.waitUntil((async () => {
    const userDisplayName = `${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`.trim() || '访客';
    const usernameText = msg.from?.username ? `@${escapeHtml(msg.from.username)}` : '未设置';
    const firstSeenText = new Date(guestRecord.first_seen || now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const lastSeenText = new Date(guestRecord.last_seen || now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const guestCardText =
      `👤 <b>访客资料</b>\n` +
      `━━━━━━━━━━━━━━\n` +
      `<b>昵称：</b>${escapeHtml(userDisplayName)}\n` +
      `<b>用户名：</b>${usernameText}\n` +
      `<b>Telegram UID：</b><code>${escapeHtml(chatIdText)}</code>\n` +
      `<b>累计消息：</b>${Number(guestRecord.messages || 0)} 条\n` +
      `<b>首次联系：</b>${escapeHtml(firstSeenText)}\n` +
      `<b>最近联系：</b>${escapeHtml(lastSeenText)}\n` +
      `<b>当前状态：</b>🟢 正常\n` +
      `━━━━━━━━━━━━━━\n` +
      `<i>回复原始消息或本资料卡，即可向该访客发送消息。</i>`;

    const guestCardResp = await sendMessage(TOKEN, OWNER_ID, guestCardText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👤 查看 Telegram 资料', url: `tg://user?id=${chatIdText}` },
            { text: '🆔 复制 UID', copy_text: { text: chatIdText } }
          ],
          [
            { text: '🚫 屏蔽访客', callback_data: `block_${chatIdText}` },
            { text: '✅ 解封访客', callback_data: `unblock_${chatIdText}` }
          ]
        ]
      }
    });

    if (guestCardResp?.ok && guestCardResp.result?.message_id) {
      await Promise.all([
        env.PMBOT.put(`msg-map-${routeId}-${guestCardResp.result.message_id}`, mappingValue, { expirationTtl: mappingTtl }),
        env.PMBOT.put(`msg-map-${guestCardResp.result.message_id}`, mappingValue, { expirationTtl: mappingTtl })
      ]);
    }
  })().catch(() => {}));

  // 诈骗库检查放在后台，并在 isolate 内缓存一小时，不再每条消息重新下载数据库。
  ctx.waitUntil(isFraud(chatId).then(async result => {
    if (result) await sendMessage(TOKEN, OWNER_ID, `⚠️ **警报**：检测到发送者 UID ${chatId} 在诈骗黑名单中！`, { parse_mode: 'Markdown' });
  }).catch(() => {}));

  return new Response('Ok');
}

// ==================================================
// 2.5 超级管理员管理模块（KV 索引，兼容旧数据）
// ==================================================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function listAllKeys(env, prefix, cap = 1000) {
  const out = []; let cursor;
  do {
    const result = await env.PMBOT.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor && out.length < cap);
  return out.slice(0, cap);
}

async function getAllRoutes(env) {
  const keys = await listAllKeys(env, 'platform:route:', 5000);
  const rows = [];
  for (const item of keys) {
    const routeId = item.name.slice('platform:route:'.length);
    const raw = await env.PMBOT.get(item.name);
    if (!raw) continue;
    try { rows.push({ routeId, config: JSON.parse(raw) }); } catch {}
  }
  return rows;
}

async function getManagedOwnersUI(env, pageNo = 0) {
  const routes = await getAllRoutes(env);
  const owners = new Map();
  for (const row of routes) {
    const uid = String(row.config.owner_id);
    if (!owners.has(uid)) owners.set(uid, []);
    owners.get(uid).push(row);
  }
  const all = [...owners.entries()].sort((a,b) => Math.max(...b[1].map(x=>x.config.created_at||0)) - Math.max(...a[1].map(x=>x.config.created_at||0)));
  const pageSize = 8, totalPages = Math.max(1, Math.ceil(all.length/pageSize));
  const page = Math.min(Math.max(0,pageNo), totalPages-1);
  const slice = all.slice(page*pageSize,(page+1)*pageSize);
  let text = `👥 <b>托管用户列表</b>\n用户数：${all.length}｜机器人：${routes.length}\n页码：${page+1}/${totalPages}\n\n`;
  const rows = [];
  for (const [uid, bots] of slice) {
    const banned = !!(await env.PMBOT.get(`platform:banned:${uid}`));
    text += `${banned?'⛔️':'🟢'} <code>${escapeHtml(uid)}</code>｜${bots.length} 个机器人\n`;
    rows.push([{ text: `${banned?'⛔':'👤'} ${uid} (${bots.length})`, callback_data: `admin_owner_${uid}` }]);
  }
  if (!slice.length) text += '暂无托管用户记录。\n';
  const nav=[]; if(page>0) nav.push({text:'⬅️ 上一页',callback_data:`admin_owner_page_${page-1}`}); if(page<totalPages-1) nav.push({text:'下一页 ➡️',callback_data:`admin_owner_page_${page+1}`}); if(nav.length) rows.push(nav);
  rows.push([{text:'🔍 搜索用户',callback_data:'admin_search_owner'},{text:'🔙 返回后台',callback_data:'admin_refresh'}]);
  return {text,markup:{inline_keyboard:rows}};
}

async function getOwnerDetailUI(env, uid) {
  const routes = (await getAllRoutes(env)).filter(x=>String(x.config.owner_id)===String(uid));
  const banned = !!(await env.PMBOT.get(`platform:banned:${uid}`));
  let text = `👤 <b>托管用户详情</b>\nUID：<code>${escapeHtml(uid)}</code>\n接入权限：${banned?'⛔️ 已禁止':'🟢 正常'}\n托管机器人：${routes.length}\n\n`;
  const rows=[];
  for (const row of routes) {
    const c=row.config;
    text += `🤖 @${escapeHtml(c.bot_username||'unknown')}｜${c.paused?'⏸ 已暂停':'🟢 运行中'}\n创建：${new Date(c.created_at||0).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n`;
    rows.push([{text:`${c.paused?'▶️':'⏸'} ${c.bot_username||row.routeId}`,callback_data:`admin_route_${row.routeId}`}]);
  }
  rows.push([{text:banned?'✅ 恢复接入权限':'🚫 禁止该用户接入',callback_data:`${banned?'admin_unban_owner_':'admin_ban_owner_'}${uid}`}]);
  rows.push([{text:'🔙 用户列表',callback_data:'admin_users'}]);
  return {text,markup:{inline_keyboard:rows}};
}

async function getRouteDetailUI(env, routeId) {
  const raw=await env.PMBOT.get(`platform:route:${routeId}`);
  if(!raw) return {text:'机器人记录不存在或已删除。',markup:{inline_keyboard:[[{text:'返回用户列表',callback_data:'admin_users'}]]}};
  const c=JSON.parse(raw); const uid=String(c.owner_id);
  const guests=await listAllKeys(env,`platform:guest:${routeId}:`,5000);
  const text=`🤖 <b>托管机器人详情</b>\n机器人：@${escapeHtml(c.bot_username||'unknown')}\n所有者：<code>${escapeHtml(uid)}</code>\nRoute：<code>${escapeHtml(routeId)}</code>\n创建时间：${new Date(c.created_at||0).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n状态：${c.paused?'⏸ 已暂停':'🟢 运行中'}\n验证：${c.enable_verify?'开启':'关闭'}\n访客记录：${guests.length}\n\n管理操作：`;
  return {text,markup:{inline_keyboard:[[{text:c.paused?'▶️ 恢复机器人':'⏸ 暂停机器人',callback_data:`${c.paused?'admin_resume_':'admin_pause_'}${routeId}`}],[{text:'💬 管理该机器人访客',callback_data:`admin_guests_for_${routeId}`}],[{text:'🗑 删除托管机器人',callback_data:`admin_delete_${routeId}`}],[{text:'🔙 所有者详情',callback_data:`admin_owner_${uid}`}]]}};
}

async function getGuestRoutesUI(env,pageNo=0) {
  const routes=await getAllRoutes(env); const pageSize=8; const totalPages=Math.max(1,Math.ceil(routes.length/pageSize)); const page=Math.min(Math.max(0,pageNo),totalPages-1);
  const slice=routes.slice(page*pageSize,(page+1)*pageSize); let text=`💬 <b>访客管理</b>\n托管机器人：${routes.length}\n页码：${page+1}/${totalPages}\n\n`; const rows=[];
  for(const r of slice){const n=(await listAllKeys(env,`platform:guest:${r.routeId}:`,5000)).length;text+=`🤖 @${escapeHtml(r.config.bot_username||'unknown')}｜${n} 位访客\n`;rows.push([{text:`@${r.config.bot_username||r.routeId} (${n})`,callback_data:`admin_guests_for_${r.routeId}`}]);}
  const nav=[];if(page>0)nav.push({text:'⬅️ 上一页',callback_data:`admin_guest_routes_${page-1}`});if(page<totalPages-1)nav.push({text:'下一页 ➡️',callback_data:`admin_guest_routes_${page+1}`});if(nav.length)rows.push(nav);rows.push([{text:'🔍 搜索访客',callback_data:'admin_search_guest'},{text:'🔙 返回后台',callback_data:'admin_refresh'}]);
  return {text,markup:{inline_keyboard:rows}};
}

async function getRouteGuestsUI(env,routeId,pageNo=0) {
  const raw=await env.PMBOT.get(`platform:route:${routeId}`);if(!raw)return {text:'机器人不存在。',markup:{inline_keyboard:[[{text:'返回',callback_data:'admin_guests'}]]}};
  const c=JSON.parse(raw);const keys=await listAllKeys(env,`platform:guest:${routeId}:`,5000);const pageSize=8,totalPages=Math.max(1,Math.ceil(keys.length/pageSize)),page=Math.min(Math.max(0,pageNo),totalPages-1);const slice=keys.slice(page*pageSize,(page+1)*pageSize);let text=`💬 <b>@${escapeHtml(c.bot_username||'unknown')} 的访客</b>\n访客数：${keys.length}｜页码：${page+1}/${totalPages}\n\n`;const rows=[];
  for(const k of slice){const g=await env.PMBOT.get(k.name,{type:'json'});if(!g)continue;const id=String(g.guest_id||k.name.split(':').pop());text+=`👤 ${escapeHtml(g.first_name||'访客')}｜<code>${escapeHtml(id)}</code>｜${g.messages||0} 条\n`;rows.push([{text:`${g.first_name||'访客'} · ${id}`,callback_data:`agd_${routeId}_${id}`}]);}
  const nav=[];if(page>0)nav.push({text:'⬅️ 上一页',callback_data:`admin_guest_page_${routeId}_${page-1}`});if(page<totalPages-1)nav.push({text:'下一页 ➡️',callback_data:`admin_guest_page_${routeId}_${page+1}`});if(nav.length)rows.push(nav);rows.push([{text:'🔙 机器人详情',callback_data:`admin_route_${routeId}`}]);return {text,markup:{inline_keyboard:rows}};
}

async function getGuestDetailUI(env,routeId,guestId) {
  const g=await env.PMBOT.get(`platform:guest:${routeId}:${guestId}`,{type:'json'});const raw=await env.PMBOT.get(`platform:route:${routeId}`);if(!g||!raw)return {text:'访客记录不存在。',markup:{inline_keyboard:[[{text:'返回访客列表',callback_data:`admin_guests_for_${routeId}`}]]}};
  const blocked=!!(await env.PMBOT.get(`isblocked-${routeId}-${guestId}`));const c=JSON.parse(raw);const text=`👤 <b>访客详情</b>\n姓名：${escapeHtml(`${g.first_name||''} ${g.last_name||''}`.trim()||'未知')}\n用户名：@${escapeHtml(g.username||'无')}\nUID：<code>${escapeHtml(guestId)}</code>\n机器人：@${escapeHtml(c.bot_username||'unknown')}\n消息数：${g.messages||0}\n首次联系：${new Date(g.first_seen||0).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n最近联系：${new Date(g.last_seen||0).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n状态：${blocked?'🚫 已屏蔽':'🟢 正常'}`;
  return {text,markup:{inline_keyboard:[[{text:blocked?'✅ 解封访客':'🚫 屏蔽访客',callback_data:`${blocked?'agu_':'agb_'}${routeId}_${guestId}`}],[{text:'🔙 访客列表',callback_data:`admin_guests_for_${routeId}`}]]}};
}

async function searchOwnersUI(env,query) {
  const q=query.toLowerCase();const routes=await getAllRoutes(env);const matched=routes.filter(x=>String(x.config.owner_id).includes(q)||String(x.config.bot_username||'').toLowerCase().includes(q)||x.routeId.toLowerCase().includes(q));
  const owners=[...new Set(matched.map(x=>String(x.config.owner_id)))].slice(0,20);let text=`🔍 <b>托管用户搜索结果</b>：${matched.length} 个机器人匹配\n关键词：${escapeHtml(query)}\n\n`;const rows=[];for(const uid of owners){const count=routes.filter(x=>String(x.config.owner_id)===uid).length;text+=`👤 <code>${escapeHtml(uid)}</code>｜${count} 个机器人\n`;rows.push([{text:`${uid} (${count})`,callback_data:`admin_owner_${uid}`}]);}if(!owners.length)text+='没有找到匹配用户。';rows.push([{text:'🔍 重新搜索',callback_data:'admin_search_owner'},{text:'🔙 用户列表',callback_data:'admin_users'}]);return {text,markup:{inline_keyboard:rows}};
}

async function searchGuestsUI(env,query) {
  const q=query.toLowerCase();const routes=await getAllRoutes(env);let found=[];for(const r of routes){const keys=await listAllKeys(env,`platform:guest:${r.routeId}:`,5000);for(const k of keys){const g=await env.PMBOT.get(k.name,{type:'json'});if(!g)continue;const id=String(g.guest_id||'');if(id.includes(q)||String(g.username||'').toLowerCase().includes(q)||String(g.first_name||'').toLowerCase().includes(q)||r.routeId.toLowerCase().includes(q))found.push({routeId:r.routeId,guestId:id,name:g.first_name||'访客',bot:r.config.bot_username||'unknown'});if(found.length>=20)break;}if(found.length>=20)break;}
  let text=`🔍 <b>访客搜索结果</b>：${found.length} 条\n关键词：${escapeHtml(query)}\n\n`;const rows=[];for(const g of found){text+=`👤 ${escapeHtml(g.name)}｜${escapeHtml(g.bot)}｜<code>${escapeHtml(g.guestId)}</code>\n`;rows.push([{text:`${g.name} · ${g.guestId}`,callback_data:`agd_${g.routeId}_${g.guestId}`}]);}if(!found.length)text+='没有找到匹配访客。';rows.push([{text:'🔍 重新搜索',callback_data:'admin_search_guest'},{text:'🔙 访客管理',callback_data:'admin_guests'}]);return {text,markup:{inline_keyboard:rows}};
}

async function deleteManagedRoute(env,routeId) {
  const raw=await env.PMBOT.get(`platform:route:${routeId}`);if(!raw)return;const c=JSON.parse(raw);
  try{await requestTelegram('deleteWebhook',c.token,{drop_pending_updates:false});}catch{}
  await env.PMBOT.delete(`platform:route:${routeId}`);await env.PMBOT.delete(`platform:owner:${c.owner_id}:route:${routeId}`);
  const ownerKey=`platform:user:${c.owner_id}`;const owner=await env.PMBOT.get(ownerKey,{type:'json'});if(owner){const routes=Array.isArray(owner.routes)?owner.routes.filter(x=>x!==routeId):(owner.routeId&&owner.routeId!==routeId?[owner.routeId]:[]);if(routes.length)await env.PMBOT.put(ownerKey,JSON.stringify({...owner,routes,routeId:routes[0]}));else await env.PMBOT.delete(ownerKey);}
  for(const prefix of [`platform:guest:${routeId}:`,`stats:${routeId}:`]){for(const k of await listAllKeys(env,prefix,5000))await env.PMBOT.delete(k.name);}
  for(const prefix of [`verified-${routeId}-`,`isblocked-${routeId}-`]){for(const k of await listAllKeys(env,prefix,5000))await env.PMBOT.delete(k.name);}
  // 旧版消息映射没有 routeId 前缀，不能在删除单个机器人时批量清理，以免影响其他机器人；映射会按原有 48 小时 TTL 自然过期。
  const total=parseInt(await env.PMBOT.get('stats:platform:total_bots')||'0');await env.PMBOT.put('stats:platform:total_bots',String(Math.max(0,total-1)));
}

// --- 辅助：平台管理员面板 ---
async function getAdminDashboardUI(platformConfig, env) {
    const totalBots = await env.PMBOT.get('stats:platform:total_bots') || '0';
    const ttlDays = Math.round(platformConfig.verify_ttl / (24 * 3600));
    const ttlText = ttlDays > 365 ? '永久' : `${ttlDays}天`;

    const text = `
🎛 **平台管理后台 (超级管理员)**

📊 **平台数据**:
• 累计托管机器人: ${totalBots}
• 托管用户 / 访客数据：可在管理模块查看

🔧 **全局设置**:
• 新用户接入: ${platformConfig.enable_new_users ? '✅ 允许' : '⛔️ 禁止'}
• 验证有效期: ${ttlText} (全局默认)

请选择操作：
    `;
    const markup = {
        inline_keyboard: [
            [
                { text: `${platformConfig.enable_new_users ? '⛔️ 停止接入' : '🟢 开放接入'}`, callback_data: 'admin_toggle_access' }
            ],
            [
                { text: `⏳ 设置有效期 (${ttlText})`, callback_data: 'admin_ttl_menu' }
            ],
            [
                { text: '👥 托管用户管理', callback_data: 'admin_users' },
                { text: '💬 访客管理', callback_data: 'admin_guests' }
            ],
            [
                { text: '🔍 搜索托管用户', callback_data: 'admin_search_owner' },
                { text: '🔍 搜索访客', callback_data: 'admin_search_guest' }
            ],
            [
                { text: "🔄 刷新面板", callback_data: 'admin_refresh' }
            ]
        ]
    };
    return { text, markup };
}

// --- 辅助：TTL 菜单 ---
function getTTLMenuUI(currentSeconds) {
    const currentDays = Math.round(currentSeconds / 86400);
    const prefix = 'admin'; 
    const text = `
⏳ **设置默认验证有效期**

用户通过验证后，多久需要重新验证？
当前：**${currentDays > 365 ? '永久' : currentDays + ' 天'}**
    `;
    const markup = {
        inline_keyboard: [
            [{ text: "1 天", callback_data: `${prefix}_set_ttl_1` }, { text: "7 天", callback_data: `${prefix}_set_ttl_7` }],
            [{ text: "30 天", callback_data: `${prefix}_set_ttl_30` }, { text: "永久", callback_data: `${prefix}_set_ttl_365` }],
            [{ text: "🔙 返回", callback_data: 'admin_refresh' }]
        ]
    };
    return { text, markup };
}

// ==========================================
// 3. 人机验证页面
// ==========================================

function handleVerifyPage(url, env) {
  const uid = url.searchParams.get('uid');
  const name = url.searchParams.get('name') || 'User';
  const user = url.searchParams.get('user') || '';
  const SITE_KEY = env.ENV_TURNSTILE_SITE_KEY;

  if (!uid) return new Response('Missing UID', { status: 400 });

  const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Human Verification</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        <style>
            :root { --bg-color: #f0f2f5; --text-color: #333; --primary: #3b82f6; }
            body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: var(--bg-color); color: var(--text-color); }
            .container { width: 100%; max-width: 400px; padding: 20px; text-align: center; }
            .icon-wrapper { background: var(--primary); width: 64px; height: 64px; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3); }
            .icon-wrapper svg { width: 32px; height: 32px; color: white; }
            h1 { font-size: 22px; margin-bottom: 8px; }
            .user-info { font-size: 14px; color: #666; margin-bottom: 24px; }
            .turnstile-wrapper { background: white; padding: 4px; border-radius: 8px; display: inline-block; margin-bottom: 20px; }
            .footer { margin-top: 40px; font-size: 12px; color: #999; display: flex; align-items: center; justify-content: center; gap: 5px; }
            .footer svg { width: 12px; height: 12px; fill: currentColor; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="icon-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.516 2.17a.75.75 0 00-1.032 0 11.209 11.209 0 01-7.877 3.08.75.75 0 00-.722.515A12.74 12.74 0 002.25 9.75c0 5.942 4.064 10.933 9.563 12.348a.749.749 0 00.374 0c5.499-1.415 9.563-6.406 9.563-12.348 0-1.39-.223-2.73-.635-3.985a.75.75 0 00-.722-.516l-.143.001c-2.996 0-5.717-1.17-7.734-3.08zm3.094 8.016a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z" clip-rule="evenodd" /></svg>
            </div>
            <h1>人机验证</h1>
            <div class="user-info">当前 Telegram 用户：<b>${escapeHtml(name)} ${escapeHtml(user)}</b></div>
            <form id="verifyForm">
                <div class="turnstile-wrapper">
                    <div class="cf-turnstile" data-sitekey="${SITE_KEY}" data-callback="onSuccess" data-language="zh-CN"></div>
                </div>
            </form>
            <div id="msg" style="color: #666; font-size: 14px;">请点击上方框体验证...</div>
            <div class="footer">
                <svg viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm0 3.45l8.27 14.3H3.73L12 5.45z"/></svg> 
                Secured by Cloudflare
            </div>
        </div>
        <script>
            window.Telegram.WebApp.ready();
            window.Telegram.WebApp.expand();
            function onSuccess(token) {
                const msg = document.getElementById('msg');
                msg.textContent = '正在提交验证...';
                
                const formData = new FormData();
                formData.append('cf-turnstile-response', token);
                const urlParams = new URLSearchParams(window.location.search);
                formData.append('uid', urlParams.get('uid'));
                formData.append('routeId', urlParams.get('routeId') || '');
                formData.append('nonce', urlParams.get('nonce') || '');

                fetch('/verify_submit', { method: 'POST', body: formData })
                .then(r => r.json())
                .then(data => {
                    if(data.success) {
                        msg.textContent = '✅ 验证成功！';
                        msg.style.color = 'green';
                        window.Telegram.WebApp.close();
                    } else {
                        msg.textContent = '❌ 验证失败，请重试';
                        msg.style.color = 'red';
                        setTimeout(() => location.reload(), 1500);
                    }
                });
            }
        </script>
    </body>
    </html>
  `;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

async function handleVerifySubmit(request, env) {
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

  let formData;
  try { formData = await request.formData(); }
  catch { return jsonResponse({ success: false, error: 'invalid_form' }, 400); }

  const token = formData.get('cf-turnstile-response');
  const uid = String(formData.get('uid') || '');
  const routeId = String(formData.get('routeId') || '');
  const nonce = String(formData.get('nonce') || '');
  const ip = request.headers.get('CF-Connecting-IP');
  const SECRET_KEY = env.ENV_TURNSTILE_SECRET_KEY;

  if (!token || !uid || !routeId || !nonce || !SECRET_KEY) {
    return jsonResponse({ success: false, error: 'missing_fields' }, 400);
  }

  const nonceKey = `verify:nonce:${nonce}`;
  const nonceRecord = await env.PMBOT.get(nonceKey, { type: 'json', cacheTtl: 30 });
  if (!nonceRecord || String(nonceRecord.uid) !== uid || String(nonceRecord.routeId) !== routeId) {
    return jsonResponse({ success: false, error: 'invalid_or_expired_nonce' }, 403);
  }

  const routeConfigRaw = await env.PMBOT.get(`platform:route:${routeId}`, { cacheTtl: 30 });
  if (!routeConfigRaw) return jsonResponse({ success: false, error: 'route_not_found' }, 404);

  let turnstileResult;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: SECRET_KEY,
        response: String(token),
        ...(ip ? { remoteip: ip } : {})
      })
    });
    turnstileResult = await response.json();
  } catch {
    return jsonResponse({ success: false, error: 'turnstile_unavailable' }, 502);
  }

  if (!turnstileResult?.success) {
    return jsonResponse({ success: false, error: 'turnstile_failed' }, 403);
  }

  let ttl = DEFAULT_TTL;
  let tokenToSend = null;
  try {
    const [platformSettings, routeConfig] = await Promise.all([
      env.PMBOT.get('platform:settings', { type: 'json', cacheTtl: 30 }),
      Promise.resolve(JSON.parse(routeConfigRaw))
    ]);
    if (platformSettings && Number(platformSettings.verify_ttl) > 0) {
      ttl = Math.min(Number(platformSettings.verify_ttl), 365 * 24 * 60 * 60);
    }
    tokenToSend = routeConfig.token || null;
  } catch {
    // 配置读取失败时保留默认 30 天 TTL；验证本身已经由 Turnstile 确认成功。
  }

  const verifiedKey = verifiedKeyForSubmit(routeId, uid);
  // 先写持久化 KV，再更新本 isolate 内存缓存。
  await env.PMBOT.put(verifiedKey, 'true', { expirationTtl: ttl });
  memorySet(verifiedMemory, verifiedKey, { expiresAt: Date.now() + Math.min(ttl, 5 * 60) * 1000 });
  await Promise.all([
    env.PMBOT.delete(nonceKey),
    env.PMBOT.delete(`verify:pending:${routeId}:${uid}`)
  ]);
  pendingVerifyMemory.delete(`verify:pending:${routeId}:${uid}`);

  if (tokenToSend) {
    // 验证状态已保存；无需再提示用户等待 KV 同步 5 秒。
    await sendMessage(tokenToSend, uid, '✅ **验证成功！**\n\n验证已完成，现在可以直接继续发送消息。', { parse_mode: 'Markdown' }).catch(() => {});
  }

  return jsonResponse({ success: true });
}

function verifiedKeyForSubmit(routeId, uid) {
  return `verified-${routeId}-${uid}`;
}

// 5. 注册主 Webhook
async function registerMainWebhook(request, url, env) {
  const webhookUrl = `${url.origin}/endpoint`;
  const r = await requestTelegram('setWebhook', env.ENV_BOT_TOKEN, { url: webhookUrl, secret_token: env.ENV_BOT_SECRET });
  return new Response(JSON.stringify(r, null, 2));
}

async function isFraud(id) {
  try {
    const db = await getFraudDatabase();
    return db.includes(String(id));
  } catch {
    return false;
  }
}
