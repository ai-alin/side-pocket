// 界面文字：中文和英文各一份。不依赖 chrome API 也能用（node 里测试时默认中文）。
//
// 语言：默认跟随浏览器界面语言（中文系 → 中文，其他 → 英文）；用户可以在设置里指定，
// 存在 storage.local 的 ui.lang（'zh' | 'en'，没有 = 跟随浏览器）。
// manifest 里的描述、工具栏提示由 Chrome 自己按 _locales/ 翻译，不走这里。
//
// 用法：tr('键', 参数…)。带参数的文案写成函数。函数名叫 tr 而不是 t：别的文件里到处用 t 表示标签。

export const LANG_KEY = 'ui.lang';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const DICT = {
  zh: {
    // 区块
    secPinned: '置顶',
    secSaved: '收藏',
    secWindow: '这个窗口',
    secDevices: '其他电脑',
    secResults: '搜索结果',
    searchPh: '搜索标签、收藏和其他电脑',
    pinnedEmpty: '把网站拖到这里置顶',
    emptySaved: '还没有收藏。把下面的网页拖到这里。',
    emptyFolder: '空文件夹，把网站拖进来',
    newFolder: '新建文件夹',
    newSubfolder: '新建子文件夹',
    newTabBtn: '新建标签页',
    newTab: '新标签页',
    // 书签里的名字
    pinnedFolder: '置顶',
    newFolderName: '新文件夹',
    untitledFolder: '未命名文件夹',
    // 行和菜单
    save: '收藏',
    pin: '置顶',
    unpin: '取消置顶',
    closeTab: '关闭标签',
    closeTabKeep: '关闭标签（保留在收藏里）',
    more: '更多',
    open: '打开',
    openHere: '在这台电脑打开',
    switchToTab: '切换到该标签',
    backToOrigin: '回到原网址',
    rename: '重命名',
    copyLink: '复制链接',
    copied: '已复制链接',
    del: '删除',
    deleteFolder: (count) => (count ? `删除文件夹（含 ${count} 项）` : '删除文件夹'),
    color: '颜色',
    folderColor: '文件夹颜色',
    noColor: '无颜色',
    colors: { grey: '灰', blue: '蓝', red: '红', yellow: '黄', green: '绿', pink: '粉', purple: '紫', cyan: '青', orange: '橙' },
    alreadyOpen: '已开着',
    nowAt: (title) => `现在：${title}`,
    belongsTo: (pinned, name) => `属于${pinned ? '置顶' : '收藏'}「${name}」`,
    folderCount: (total, open) => (open ? `${total} 个网站，${open} 个开着` : `${total} 个网站`),
    notFound: (q) => `没有找到「${q}」。试试网址里的关键词。`,
    // 删除和撤销
    deleted: (folder, name, count) => (folder ? `已删除文件夹「${name}」${count ? `（含 ${count} 项）` : ''}` : `已删除「${name}」`),
    undo: '撤销',
    undoGone: '撤销不了了，这一项已经删掉',
    // 其他电脑
    lastUpdated: (name, when) => `${name}：最后更新 ${when}`,
    deviceHeading: (name, when) => `${name} · 最后更新 ${when}`,
    deviceNoTabs: '这台电脑现在没有开着的网页',
    deviceSkipped: (count) => `还有 ${count} 个网页太多没同步过来`,
    noDevices: '在另一台电脑的 Chrome 里装上 Side Pocket，它开着的网页会出现在这里',
    removeDevice: '移除这台设备',
    deviceRemoved: (name) => `已移除「${name}」。如果它还在用，下次有变化时会重新出现。`,
    anotherComputer: '另一台电脑',
    computer: '电脑',
    justNow: '刚刚',
    minsAgo: (m) => `${m} 分钟前`,
    hoursAgo: (h) => `${h} 小时前`,
    yesterday: (hm) => `昨天 ${hm}`,
    monthDay: (month, day) => `${month}月${day}日`,
    // 同步状态
    syncOk: '同步已开启',
    syncBad: '未同步',
    syncOff: '未开启同步',
    syncOkTip: '这台电脑开着的网页清单已交给 Chrome 同步。要登录 Chrome 并开启同步，它才会出现在你的其他电脑上，可能要等一会儿。置顶和收藏存在 Chrome 书签里',
    syncOffPendingTip: '已停止共享这台电脑开着的网页。之前同步出去的清单还没删掉，稍后自动重试',
    syncOffTip: '这台电脑开着的网页不会同步到其他电脑（可以在设置里打开）；置顶和收藏存在 Chrome 书签里，不受影响',
    sync_quota: '同步空间不够，这台电脑的网页只同步了一部分。可以在「其他电脑」里移除不再用的旧设备。',
    sync_rate: '写入太频繁，被 Chrome 限流，稍后自动重试。',
    sync_error: '同步失败，稍后自动重试。',
    // 出错
    opFailed: (msg) => `操作失败：${msg}`,
    unknownError: '未知错误',
    cantSave: '这个网页不能收藏',
    // 收藏时选位置、存完的提示
    saveTo: '收藏到',
    saveTop: '收藏顶层',
    newFolderDots: '新建文件夹…',
    currentPlace: '现在在这',
    savedTop: '已收藏',
    savedTo: (name) => `已收藏到「${name}」`,
    pinnedOk: (name) => `已置顶「${name}」`,
    movedTo: (from, to) => `已从「${from}」移到「${to}」`,
    alreadyIn: (name) => `已经在「${name}」里了`,
    alreadyPinned: '已经在置顶里了',
    errInvalid: '无效的操作',
    errNoFolderHere: '该区域不能放文件夹',
    // 设置
    settings: '设置',
    appearance: '外观',
    font: '字体',
    fontSystem: '跟随系统',
    weightNormal: '普通文字粗细',
    weightStrong: '强调文字粗细',
    weights: { 300: '细', 400: '常规', 500: '中等', 600: '半粗', 700: '粗' },
    fontSize: '字号',
    sizes: { s: '小', m: '标准', l: '大' },
    fontNote: '字体从这台电脑已安装的字体里选，只对这台电脑生效。强调文字是文件夹名、开着的收藏和当前标签。有的字体没有这么多粗细，选了看不出变化是正常的。',
    resetLook: '恢复默认外观',
    language: '语言',
    langAuto: '跟随浏览器',
    deviceNameTitle: '这台电脑的名字',
    deviceNamePh: '比如：公司、家里',
    deviceNameNote: '在其他电脑的「其他电脑」里显示这个名字。',
    deviceNamed: (name) => `这台电脑叫「${name}」，其他电脑上会这样显示`,
    shareLabel: '把这台电脑开着的网页同步到我的其他电脑',
    shareNote: '通过 Chrome 同步保存在你的 Google 账号里，只有你的其他电脑能看到。关掉后不再上传，并把这台电脑已同步的清单删掉；其他电脑上可能要过一会儿才消失。',
    shareOn: '已打开：这台电脑开着的网页会出现在你其他电脑的侧栏里',
    shareOff: '已关闭：这台电脑的网页清单已从同步里删掉',
    shareOffPending: '已停止共享。之前同步出去的清单暂时没删掉，稍后自动重试',
    shareFailed: (msg) => `没改成：${msg}`,
    noResponse: '后台没有响应',
    shortcutTitle: '快捷键',
    toggleSide: '打开 / 关闭侧边栏',
    notSet: '未设置',
    shortcutHint: '快捷键可能被别的扩展占用了，点下面的按钮重新设置。',
    editShortcut: '修改快捷键',
    sideNote: '点工具栏上的扩展图标也可以打开或关闭侧边栏。侧边栏放左边还是右边，在 Chrome 设置 → 外观 → 侧边栏位置里选。',
  },

  en: {
    secPinned: 'Pinned',
    secSaved: 'Saved',
    secWindow: 'This window',
    secDevices: 'Other computers',
    secResults: 'Results',
    searchPh: 'Search tabs, saved sites, other computers',
    pinnedEmpty: 'Drag a site here to pin it',
    emptySaved: 'Nothing saved yet. Drag a tab from below to save it here.',
    emptyFolder: 'Empty folder. Drag sites in.',
    newFolder: 'New folder',
    newSubfolder: 'New subfolder',
    newTabBtn: 'New tab',
    newTab: 'New Tab',
    pinnedFolder: 'Pinned',
    newFolderName: 'New folder',
    untitledFolder: 'Untitled folder',
    save: 'Save',
    pin: 'Pin',
    unpin: 'Unpin',
    closeTab: 'Close tab',
    closeTabKeep: 'Close tab (stays saved)',
    more: 'More',
    open: 'Open',
    openHere: 'Open on this computer',
    switchToTab: 'Switch to tab',
    backToOrigin: 'Go back to saved address',
    rename: 'Rename',
    copyLink: 'Copy link',
    copied: 'Link copied',
    del: 'Delete',
    deleteFolder: (count) => (count ? `Delete folder (${n(count, 'item', 'items')})` : 'Delete folder'),
    color: 'Color',
    folderColor: 'Folder color',
    noColor: 'No color',
    colors: { grey: 'Grey', blue: 'Blue', red: 'Red', yellow: 'Yellow', green: 'Green', pink: 'Pink', purple: 'Purple', cyan: 'Cyan', orange: 'Orange' },
    alreadyOpen: 'Open',
    nowAt: (title) => `Now on: ${title}`,
    belongsTo: (pinned, name) => `Tab of ${pinned ? 'pinned' : 'saved'} site “${name}”`,
    folderCount: (total, open) => (open ? `${n(total, 'site', 'sites')}, ${open} open` : n(total, 'site', 'sites')),
    notFound: (q) => `Nothing matches “${q}”. Try a word from the address.`,
    deleted: (folder, name, count) => (folder ? `Deleted folder “${name}”${count ? ` (${n(count, 'item', 'items')})` : ''}` : `Deleted “${name}”`),
    undo: 'Undo',
    undoGone: 'Too late to undo. This item is gone.',
    lastUpdated: (name, when) => `${name}: last updated ${when}`,
    deviceHeading: (name, when) => `${name} · updated ${when}`,
    deviceNoTabs: 'No pages open on this computer right now',
    deviceSkipped: (count) => `${n(count, 'more page', 'more pages')} not synced (too many open)`,
    noDevices: 'Install Side Pocket in Chrome on another computer and its open pages will show up here',
    removeDevice: 'Remove this computer',
    deviceRemoved: (name) => `Removed “${name}”. If it is still in use, it will come back the next time its tabs change.`,
    anotherComputer: 'Another computer',
    computer: 'Computer',
    justNow: 'Just now',
    minsAgo: (m) => `${m} min ago`,
    hoursAgo: (h) => `${h} hr ago`,
    yesterday: (hm) => `Yesterday ${hm}`,
    monthDay: (month, day) => `${MONTHS[month - 1]} ${day}`,
    syncOk: 'Sync on',
    syncBad: 'Not synced',
    syncOff: 'Sync off',
    syncOkTip: 'The list of pages open on this computer has been handed to Chrome sync. It reaches your other computers only if you are signed in to Chrome with sync on, and that can take a while. Pinned and saved sites live in your Chrome bookmarks.',
    syncOffPendingTip: 'Sharing of this computer’s open pages is stopped. The list that was already synced has not been deleted yet. Will retry shortly.',
    syncOffTip: 'The pages open on this computer are not shared with your other computers (you can turn this on in Settings). Pinned and saved sites live in your Chrome bookmarks and are not affected.',
    sync_quota: 'Out of sync storage, so only some of this computer’s pages were synced. You can remove computers you no longer use under “Other computers”.',
    sync_rate: 'Chrome is limiting how often we can sync. Will retry shortly.',
    sync_error: 'Sync failed. Will retry shortly.',
    opFailed: (msg) => `That didn’t work: ${msg}`,
    unknownError: 'unknown error',
    cantSave: 'This page can’t be saved',
    saveTo: 'Save to',
    saveTop: 'Top level',
    newFolderDots: 'New folder…',
    currentPlace: 'Here',
    savedTop: 'Saved',
    savedTo: (name) => `Saved to “${name}”`,
    pinnedOk: (name) => `Pinned “${name}”`,
    movedTo: (from, to) => `Moved from “${from}” to “${to}”`,
    alreadyIn: (name) => `Already in “${name}”`,
    alreadyPinned: 'Already pinned',
    errInvalid: 'Invalid request',
    errNoFolderHere: 'Folders can’t go here',
    settings: 'Settings',
    appearance: 'Appearance',
    font: 'Font',
    fontSystem: 'System default',
    weightNormal: 'Regular text weight',
    weightStrong: 'Emphasized text weight',
    weights: { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold' },
    fontSize: 'Text size',
    sizes: { s: 'Small', m: 'Standard', l: 'Large' },
    fontNote: 'Fonts come from the ones installed on this computer and apply to this computer only. Emphasized text is folder names, saved sites that are open, and the current tab. Not every font has every weight, so some choices may look the same.',
    resetLook: 'Reset appearance',
    language: 'Language',
    langAuto: 'Same as browser',
    deviceNameTitle: 'Name of this computer',
    deviceNamePh: 'e.g. Work, Home',
    deviceNameNote: 'Shown under “Other computers” on your other computers.',
    deviceNamed: (name) => `This computer is now “${name}” on your other computers`,
    shareLabel: 'Share the pages open on this computer with my other computers',
    shareNote: 'Stored in your Google account through Chrome sync. Only your own computers can see it. Turning this off stops uploads and deletes this computer’s synced list; it may take a while to disappear from your other computers.',
    shareOn: 'On: pages open on this computer will show up on your other computers',
    shareOff: 'Off: this computer’s page list was removed from sync',
    shareOffPending: 'Sharing stopped. The list that was already synced could not be deleted yet. Will retry shortly.',
    shareFailed: (msg) => `Couldn’t change that: ${msg}`,
    noResponse: 'no response from the extension',
    shortcutTitle: 'Shortcut',
    toggleSide: 'Open / close the side panel',
    notSet: 'Not set',
    shortcutHint: 'Another extension may be using this shortcut. Use the button below to set it again.',
    editShortcut: 'Change shortcut',
    sideNote: 'You can also click the extension’s toolbar icon to open or close the side panel. To move the panel to the left or right, go to Chrome Settings → Appearance → Side panel position.',
  },
};

/** 浏览器界面语言：中文系 → 'zh'，其他 → 'en'；node 里（没有浏览器）→ 'zh' */
export function detect() {
  let ui = '';
  try {
    ui = globalThis.chrome?.i18n?.getUILanguage?.() || '';
  } catch {
    ui = '';
  }
  if (!ui) return 'zh';
  return ui.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let lang = detect();

/** pref：'zh' | 'en'，其他值 = 跟随浏览器。返回实际用的语言 */
export function setLang(pref) {
  lang = pref === 'zh' || pref === 'en' ? pref : detect();
  return lang;
}

export const getLang = () => lang;

/** 读出用户在设置里选的语言并生效 */
export async function loadLang() {
  try {
    return setLang((await chrome.storage.local.get(LANG_KEY))[LANG_KEY]);
  } catch {
    return lang;
  }
}

export function tr(key, ...args) {
  const s = DICT[lang][key] ?? DICT.zh[key];
  if (s == null) return key;
  return typeof s === 'function' ? s(...args) : s;
}

/** 测试用：两种语言的全部文案 */
export const _dict = DICT;
