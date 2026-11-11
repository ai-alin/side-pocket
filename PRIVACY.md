# Side Pocket Privacy Policy

[中文版见下方](#side-pocket-隐私说明)

Side Pocket has no server of its own. It does not collect anything, does not send anything to the developer or to third parties, and contains no analytics or ads.

## What data is used and where it lives

| Data | Where it is stored | Who can see it |
|---|---|---|
| Pinned and saved sites | Chrome bookmarks (Other bookmarks / Side Pocket) | Only you. If you are signed in to Chrome with bookmark sync on, Chrome syncs them to your other devices |
| Tabs in this window | Not stored. Read from Chrome each time | Shown on this computer only |
| List of pages open on this computer (addresses and titles) | Chrome sync storage (`chrome.storage.sync`) | Only your other computers that are signed in to the same Google account and have Side Pocket installed |
| Folder colors | Chrome sync storage | Same as above |
| Computer name, collapsed folders, font, language and other settings | This computer (`chrome.storage.local`) | This computer only |

## About "Other computers"

So that you can pick up where you left off on another computer, Side Pocket writes the addresses and titles of the ordinary web pages (`http` / `https`) open on this computer to Chrome sync storage.

- Pages in Incognito windows, `chrome://` pages and the New Tab page are never uploaded.
- The data is kept in your own Google account by Chrome's sync feature. The developer of Side Pocket has no access to it.
- If you are not signed in to Chrome, or sync is off, the list stays on this computer.
- You can turn this off at any time in Settings ("Share the pages open on this computer with my other computers"). Turning it off deletes the uploaded list immediately and stops further uploads.

## Permissions

| Permission | What it is used for |
|---|---|
| `sidePanel` | Showing Side Pocket in Chrome's side panel |
| `tabs` | Reading tab titles and addresses to show, switch, close and reorder tabs |
| `bookmarks` | Storing pinned and saved sites as Chrome bookmarks |
| `storage` | Saving settings and the synced data described above |
| `favicon` | Showing site icons |
| `alarms` | Periodically refreshing the "last updated" time of this computer's list |
| `fontSettings` | Reading the names of the fonts installed on this computer so you can choose the font used in the side panel. Chrome's own font settings are not changed |

Side Pocket does not request access to page content, does not inject code into any web page, and cannot read what you see or type on web pages.

## After uninstalling

When you uninstall the extension, Chrome deletes its local data and its data in sync storage. Pinned and saved sites are ordinary Chrome bookmarks and are kept; you can view or delete them in the bookmark manager.

## Contact

Please use the project's issue tracker.

---

# Side Pocket 隐私说明

Side Pocket 没有自己的服务器，不收集、不上传任何数据给开发者或第三方，也没有统计和广告。

## 用到哪些数据，放在哪里

| 数据 | 放在哪里 | 谁能看到 |
|---|---|---|
| 置顶和收藏 | Chrome 书签（其他书签 / Side Pocket） | 只有你。登录了 Chrome 并开启书签同步时，由 Chrome 同步到你的其他设备 |
| 这个窗口的标签 | 不保存，每次直接从 Chrome 读取 | 只在本机显示 |
| 这台电脑开着的网页清单（网址和标题） | Chrome 同步存储（`chrome.storage.sync`） | 只有登录同一个 Google 账号、也装了 Side Pocket 的你的其他电脑 |
| 文件夹颜色 | Chrome 同步存储 | 同上 |
| 电脑名字、文件夹折叠状态、字体和语言等设置 | 本机（`chrome.storage.local`） | 只在本机 |

## 关于「其他电脑」

为了让你在另一台电脑上接着看，Side Pocket 会把这台电脑开着的普通网页（`http` / `https`）的网址和标题写进 Chrome 同步存储。

- 无痕窗口的网页、`chrome://` 页面、新标签页不会上传。
- 数据由 Chrome 的同步功能保存在你自己的 Google 账号里，Side Pocket 的开发者接触不到。
- 没有登录 Chrome 或没有开启同步时，这份清单只留在本机。
- 可以随时在设置里关掉「把这台电脑开着的网页同步到我的其他电脑」。关掉后，已经上传的清单会立刻删除，之后不再上传。

## 用到的权限

| 权限 | 用来做什么 |
|---|---|
| `sidePanel` | 在 Chrome 侧边栏里显示 |
| `tabs` | 读取标签的标题和网址，用来显示、切换、关闭、排序标签 |
| `bookmarks` | 把置顶和收藏存成 Chrome 书签 |
| `storage` | 保存设置，以及上面说的同步数据 |
| `favicon` | 显示网站图标 |
| `alarms` | 定时把本机清单的「最后更新」时间同步出去 |
| `fontSettings` | 读取这台电脑已安装的字体名，让你在设置里选侧栏用的字体。不修改 Chrome 的字体设置 |

Side Pocket 不申请访问网页内容的权限，不往任何网页里注入代码，读不到你在网页里看到或输入的内容。

## 卸载以后

卸载插件时，Chrome 会删除它的本机数据和同步存储里的数据。置顶和收藏是普通的 Chrome 书签，会保留，可以在书签管理器里查看或删除。

## 联系

有问题请在项目的问题反馈页提出。
