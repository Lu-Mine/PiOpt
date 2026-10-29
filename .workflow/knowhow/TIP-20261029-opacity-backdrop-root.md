---
id: "TIP-20261029-opacity-backdrop-root"
title: "磨砂表面外层的容器不能动画 opacity（Backdrop Root）"
keywords: ["磨砂", "材质", "玻璃", "backdrop-filter", "Backdrop Root", "opacity", "表头", "色差", "叠色", "glass", "工作面板", "work-panel"]
status: active
created: 2026-10-29
source: pi-desktop
---

现象：给包着磨砂的容器做淡入时，动画期间里面的 backdrop-filter 看不到后面的背景图，退化成一层未模糊的灰，最后一帧 opacity 回到 1 才啪一下恢复。

原因在 CSS Filter Effects 2：opacity < 1 的元素本身就是 Backdrop Root，它内部的 backdrop-filter 只采样这棵子树，外面被模糊掉的东西看不见了。

做法：不给自己动画包着磨砂表面的容器（.app-shell、.main-pane，后者里面包着 .conversation-topbar / .main-titlebar），改成动画它们里面的内容层（.chat-surface、.route-page、.settings-content）。工作面板与侧栏的进出场（含宿主的 .sidebar.is-entering、.work-panel.is-exiting）只做位移和宽度伸缩，不改 opacity。

同源的第二条规矩：工作面板表头只保留一层面板磨砂，不要再叠第二层材质；底色从表头下缘起铺。表头色差在这条上反复修过（a469420、33c3ed1、81cc961、ac5ef1d），动材质前先确认没把第二层加回来。

文件：features/appearance/glass.js、renderer/base.css、renderer/components.css
