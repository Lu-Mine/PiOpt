'use strict';

/**
 * Permission labels for the detail view.
 *
 * The host ships its own localized permission table inside app.asar; the names
 * and one-line explanations below are taken from it (zh-CN), grouped with the
 * same risk tiers the plugins page shows. Keeping a local copy is what lets the
 * detail panel explain "net.fetch" instead of printing a bare token.
 */

const RISK = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

/** id → [name, description, risk] */
const TABLE = {
  'ui.panel': ['显示插件面板', '允许插件在应用内显示独立面板。', RISK.LOW],
  'ui.theme': ['提供主题', '在设置中新增一个可选主题，只影响外观，不涉及数据。', RISK.LOW],
  'ui.settings': ['添加设置项', '在插件的设置页新增配置项。', RISK.MEDIUM],
  'ui.view': ['显示工作面板视图', '在右侧工作面板中显示插件视图。', RISK.MEDIUM],
  'ui.microphone': ['使用麦克风', '允许隔离面板请求麦克风音频，不授予摄像头权限。', RISK.MEDIUM],
  'ui.window.appearance': ['自定义窗口外观', '让原生窗口背景和 Windows 圆角与该插件主题一致。只影响外观，不涉及数据。', RISK.MEDIUM],
  notify: ['显示通知', '显示应用内提示和系统通知。', RISK.LOW],

  'net.fetch': ['访问网络', '可发起出站网络请求。', RISK.HIGH],
  'net.anyHost': ['访问任意网络地址', '可访问任意服务器（HTTP(S)/WebSocket），包括你自行填写的自建服务地址；云元数据地址始终拒绝。', RISK.HIGH],
  'net.websocket': ['建立实时双向连接', '与插件声明的域名建立实时双向连接。', RISK.HIGH],

  'fs.read': ['读取文件', '只读，且仅限插件声明的路径；凭据与仓库内部文件始终不可读。', RISK.MEDIUM],
  'fs.write': ['修改文件', '可创建或修改文件，且仅限插件声明的路径；其余路径每次都会先问你。', RISK.HIGH],
  'fs.delete': ['删除文件', '可删除声明范围内或自己写入的文件；删除进入系统回收站，其余路径每次都会先问你。', RISK.HIGH],
  'fs.read.workspace': ['读取项目文件（旧版）', '仅可读取当前项目内的文件。', RISK.MEDIUM],
  'fs.write.workspace': ['修改项目文件（旧版）', '在文件范围机制之前声明，插件更新前已无法写入任何位置。', RISK.HIGH],
  'fs.delete.workspace': ['删除项目文件（旧版）', '在文件范围机制之前声明，现在只能删除自己写入的文件。', RISK.HIGH],

  'clipboard.read': ['读取剪贴板及其历史', '可能读取当前剪贴板内容以及应用运行期间保留的剪贴板历史。', RISK.MEDIUM],
  'clipboard.write': ['写入剪贴板', '可能覆盖当前剪贴板中的内容。', RISK.MEDIUM],
  'shell.openExternal': ['打开外部链接', '可在默认浏览器打开链接。', RISK.MEDIUM],

  'models.list': ['列出已登录的模型', '可以看到你已登录的模型，但拿不到密钥。', RISK.MEDIUM],
  'usage.read': ['读取用量统计', '分页列出已完成回合的用量事实（每回合 token 计数与会话标题），不包含任何消息内容。', RISK.MEDIUM],
  'provider.register': ['将服务添加到模型列表', '把此插件定义的服务添加到设置的服务列表；接口地址和模型由插件提供，API 密钥留在 PI-Desktop 中。', RISK.HIGH],
  'provider.oauth': ['为插件声明的服务登录', '允许插件为自己声明的 Provider 执行 OAuth 登录和令牌刷新。PI-Desktop 会加密令牌。', RISK.HIGH],

  'session.read': ['读取当前发给模型的对话', '可以读取当前这次工具调用所在会话发给模型的对话，包括工具结果。', RISK.HIGH],
  'session.read.own': ['读取本插件自己的会话', '只能读取该插件自己创建或参与的会话。', RISK.MEDIUM],
  'session.manage.own': ['管理本插件自己的会话', '可以创建、重命名或删除该插件自己的会话。', RISK.HIGH],
  'session.import': ['导入会话', '把外部记录导入为 PI-Desktop 会话。', RISK.HIGH],
  'session.autoTitle': ['读取首轮标题上下文并更新自动标题', '只能读取符合条件会话的首条提示和首条回复，并仅在标题未被手动修改时更新；不能读取完整会话记录。', RISK.MEDIUM],

  'agent.tool.register': ['为智能体添加工具', '允许 AI 调用此插件提供的额外工具。', RISK.HIGH],
  'agent.prompt.inject': ['调整智能体指令', '可能修改发送给智能体的指令。', RISK.HIGH],
  'agent.complete': ['用你的模型发起一次补全', '会消耗你的模型额度发起一次补全；插件拿不到 API 密钥。', RISK.HIGH],
  'agent.extension': ['在 agent 内运行代码', '在 agent 进程内执行 ExtensionAPI 模块，拥有与 agent 自身工具相同的权限。只启用你信任的代码。', RISK.HIGH],

  'background.service': ['保持后台服务运行', '插件启用期间保持一个后台工作进程运行。', RISK.MEDIUM],
  'bus.publish': ['向其他插件发送消息', '可在其声明的主题上发送消息。', RISK.MEDIUM],
  'bus.subscribe': ['接收其他插件的消息', '可在其声明的主题上接收消息。', RISK.MEDIUM],

  'mcp.server.local': ['运行本地 MCP 服务', '在本机启动一个程序，为智能体提供额外工具。', RISK.HIGH],
  'mcp.server.remote': ['连接远端 MCP 服务', '把工具调用发送到插件声明的远端 MCP 端点，端点可能使用未加密的 HTTP。', RISK.HIGH],

  'renderer.extension': ['在聊天插槽绘制界面', '把该插件的渲染模块载入应用窗口，在消息操作列、回复追加区、工具卡、代码块、输入区等插槽绘制界面。模块与 PI-Desktop 共享同一页面。', RISK.HIGH],
  'desktop.control': ['控制桌面操作', '允许插件调用经过审查的 PI-Desktop 操作目录；破坏性操作仍需 confirm=true。', RISK.HIGH],
  'keyboard.globalShortcut': ['注册系统级快捷键', '注册系统级快捷键，在 PI-Desktop 未聚焦时触发本插件自己的命令。', RISK.HIGH],
  'browser.cdp': ['控制工作面板浏览器', '可导航工作面板浏览器、读取页面、运行 JavaScript，并发送白名单内的 Chrome DevTools 命令。', RISK.HIGH],
  'composer.suggest': ['在输入框中给出建议', '允许插件在草稿为空时于输入框占位处显示一条可忽略的建议，只有你按 Tab 它才进入草稿。', RISK.LOW],
  'composer.transform': ['转换输入框中的文本', '允许插件转换你在输入框中主动选择的文本；插件会收到草稿文本和所选模型标识，不会收到对话历史或附件。', RISK.HIGH],
  'secrets.store': ['保存加密凭据', '把密钥保存在 PI-Desktop 的加密存储中。', RISK.HIGH],
  'project.create': ['创建项目', '可以新建项目并写入其初始内容。', RISK.HIGH],
};

const RISK_ORDER = [RISK.HIGH, RISK.MEDIUM, RISK.LOW];

function permissionInfo(id, locale = 'zh-CN') {
  const row = TABLE[id];
  const zh = String(locale).toLowerCase().startsWith('zh');
  if (!row) {
    return { id, name: id, description: '', risk: RISK.MEDIUM };
  }
  return {
    id,
    name: zh ? row[0] : id,
    description: zh ? row[1] : '',
    risk: row[2],
  };
}

/** Group a permission list into high → medium → low, keeping declaration order inside each tier. */
function groupPermissions(ids, locale) {
  const seen = new Set();
  const items = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    items.push(permissionInfo(id, locale));
  }
  return RISK_ORDER.map(risk => ({
    risk,
    items: items.filter(item => item.risk === risk),
  })).filter(group => group.items.length);
}

module.exports = { RISK, RISK_ORDER, TABLE, permissionInfo, groupPermissions };
