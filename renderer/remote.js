/*
 * 手机 view.
 *
 * One job: get a phone connected. So the page is built around the two things a
 * phone needs — the address (as a scannable code, because typing a URL on a
 * phone to reach the machine you are sitting at is the whole friction) — and
 * the pairing code that turns that phone into a known device.
 *
 * Everything here reads the feature's own status payload. Nothing is cached and
 * nothing is invented: when the gateway is off the page shows the switch and the
 * promise of a code, not a dimmed copy of the last address.
 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const root = () => document.getElementById("view-remote");

  const state = {
    booted: false,
    status: null,
    busy: "",
    error: "",
    flash: "",
    portDraft: "",
    timer: null,
  };

  function invoke(channel, payload) {
    if (!bridge || typeof bridge.invoke !== "function") return Promise.reject(new Error("plugin bridge 不可用"));
    return bridge.invoke(channel, payload);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(paths, size) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size || 16);
    svg.setAttribute("height", size || 16);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  const ICONS = {
    copy: () => icon(["M9 9h10v12H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"]),
    refresh: () => icon(["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"]),
    trash: () => icon(["M4 7h16", "M9 7V4h6v3", "M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13", "M10 11v6M14 11v6"]),
    phone: () => icon(["M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5z", "M11 18.5h2"]),
  };

  function button(label, run, options) {
    const opts = options || {};
    const node = el("button", `ui-btn ui-btn-sm ${opts.primary ? "ui-btn-primary" : ""} ${opts.danger ? "ui-btn-danger" : ""}`.trim());
    node.type = "button";
    if (opts.icon && ICONS[opts.icon]) node.append(ICONS[opts.icon]());
    if (label) node.append(el("span", "", label));
    if (opts.aria) node.setAttribute("aria-label", opts.aria);
    node.disabled = Boolean(opts.disabled);
    node.addEventListener("click", run);
    return node;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function flash(text) {
    state.flash = text;
    render();
    setTimeout(() => {
      if (state.flash !== text) return;
      state.flash = "";
      render();
    }, 1800);
  }

  function relative(iso) {
    if (!iso) return "";
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return "";
    const diff = Date.now() - time;
    if (diff < 60_000) return "刚刚活跃";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前活跃`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
    return `${Math.floor(diff / 86_400_000)} 天前活跃`;
  }

  function duration(iso) {
    if (!iso) return "";
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return "";
    const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
    if (minutes < 1) return "已运行不到一分钟";
    if (minutes < 60) return `已运行 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `已运行 ${hours} 小时`;
    return `已运行 ${Math.floor(hours / 24)} 天`;
  }

  async function load() {
    try {
      state.status = await invoke("remote.status");
      state.error = "";
      if (!state.portDraft && state.status) state.portDraft = String(state.status.configuredPort);
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
    }
    render();
  }

  async function act(name, run) {
    if (state.busy) return;
    state.busy = name;
    render();
    try {
      state.status = await run();
      state.error = "";
      state.portDraft = state.status ? String(state.status.configuredPort) : "";
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
    } finally {
      state.busy = "";
      render();
    }
  }

  // ------------------------------------------------------------------ pieces

  function statusBar(status) {
    const bar = el("header", "rm-bar");

    const left = el("div", "rm-bar-main");
    const title = el("div", "rm-bar-title");
    title.append(el("span", "", "手机控制"));
    if (status.running) {
      const dot = el("span", "rm-dot");
      dot.setAttribute("aria-hidden", "true");
      title.append(dot);
      title.append(el("span", "rm-bar-meta", duration(status.startedAt)));
    }
    left.append(title);
    left.append(
      el(
        "div",
        "rm-bar-sub",
        status.running
          ? `${status.deviceCount} 台已配对设备 · 端口 ${status.port}`
          : "关闭时端口不监听，手机连不上"
      )
    );

    const control = el("label", "switch-row rm-switch");
    control.htmlFor = "rm-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = "rm-toggle";
    input.checked = Boolean(status.running);
    input.disabled = Boolean(state.busy);
    input.addEventListener("change", () => {
      act("toggle", () => invoke(input.checked ? "remote.start" : "remote.stop"));
    });
    const track = el("span", "switch");
    track.setAttribute("aria-hidden", "true");
    track.append(el("span"));
    control.append(input, track);

    bar.append(left, control);
    return bar;
  }

  function qrCard(status) {
    const url = status.url || "";
    const card = el("section", "rm-card rm-connect");

    const code = el("div", "rm-qr");
    if (url && window.PiOptQr) {
      try {
        code.innerHTML = window.PiOptQr.svg(url, { margin: 2, dark: "#101418", light: "transparent" });
      } catch (error) {
        code.textContent = "二维码生成失败";
      }
    } else {
      code.textContent = "二维码不可用";
    }
    card.append(code);

    const side = el("div", "rm-connect-body");

    const addressRow = el("div", "rm-address");
    const address = el("code", "rm-address-text", url || "没有可用的内网地址");
    addressRow.append(address);
    addressRow.append(
      button("复制", async () => {
        const ok = await copyText(url);
        flash(ok ? "地址已复制" : "复制失败，请手动输入");
      }, { icon: "copy", aria: "复制地址", disabled: !url })
    );
    side.append(addressRow);

    const others = (status.addresses || []).filter((entry) => entry.url && entry.url !== url);
    if (others.length) {
      side.append(el("div", "rm-alt", others.map((entry) => `${entry.address}（${entry.name}）`).join("　")));
    }

    const codeBlock = el("div", "rm-code-block");
    const codeLabel = el("div", "rm-label", "配对码");
    const digits = String(status.code || "").replace(/(\d{3})(\d{3})/, "$1 $2");
    const codeValue = el("output", "rm-code", digits || "------");
    const rotate = button("换一个", () => act("code", () => invoke("remote.rotateCode")), {
      icon: "refresh",
      disabled: Boolean(state.busy),
    });
    const codeRow = el("div", "rm-code-row");
    codeRow.append(codeValue, rotate);
    codeBlock.append(codeLabel, codeRow);
    side.append(codeBlock);

    const portRow = el("div", "rm-port-row");
    portRow.append(el("span", "rm-label", "端口"));
    const portInput = document.createElement("input");
    portInput.type = "number";
    portInput.min = "1024";
    portInput.max = "65535";
    portInput.className = "rm-port";
    portInput.value = state.portDraft || String(status.configuredPort);
    portInput.setAttribute("aria-label", "端口");
    portInput.addEventListener("input", () => {
      state.portDraft = portInput.value;
    });
    portInput.addEventListener("blur", () => {
      const next = Number(portInput.value);
      if (!Number.isInteger(next) || next < 1024 || next > 65535) {
        state.portDraft = String(status.configuredPort);
        portInput.value = state.portDraft;
        flash("端口需在 1024–65535 之间");
        return;
      }
      if (next === status.configuredPort) return;
      act("port", () => invoke("remote.setPort", { port: next }));
    });
    portInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") portInput.blur();
    });
    portRow.append(portInput);
    portRow.append(el("span", "rm-hint", "改端口会重启一次网关"));
    side.append(portRow);

    card.append(side);
    return card;
  }

  function emptyCard() {
    const card = el("section", "rm-card rm-empty");
    const art = el("div", "rm-empty-art");
    art.append(ICONS.phone());
    const copy = el("div");
    copy.append(el("div", "rm-empty-title", "还没有打开"));
    copy.append(
      el(
        "div",
        "rm-empty-text",
        "打开上面的开关，这里会出现一个二维码和六位配对码；手机连同一个 Wi-Fi，扫码输入配对码即可。"
      )
    );
    card.append(art, copy);
    return card;
  }

  function devicesCard(status) {
    const card = el("section", "rm-card");
    const head = el("div", "rm-card-head");
    head.append(el("h2", "", "已配对设备"));
    head.append(el("span", "rm-count", String(status.deviceCount || 0)));
    card.append(head);

    const devices = Array.isArray(status.devices) ? status.devices : [];
    if (!devices.length) {
      card.append(el("p", "rm-empty-line", "手机配对后会出现在这里，可以随时移除。"));
      return card;
    }

    const list = el("ul", "rm-devices");
    for (const device of devices) {
      const item = el("li", "rm-device");
      const main = el("div", "rm-device-main");
      main.append(el("div", "rm-device-name", device.name || "手机"));
      main.append(el("div", "rm-device-meta", relative(device.lastSeenAt || device.createdAt)));
      item.append(main);
      item.append(
        button("", () => {
          act("revoke", () => invoke("remote.revoke", { name: device.name, createdAt: device.createdAt }));
        }, { icon: "trash", aria: `移除 ${device.name || "设备"}`, danger: true, disabled: Boolean(state.busy) })
      );
      list.append(item);
    }
    card.append(list);
    return card;
  }

  function aboutCard() {
    const card = el("section", "rm-card");
    const head = el("div", "rm-card-head");
    head.append(el("h2", "", "手机端能做什么"));
    card.append(head);

    const rows = [
      ["看会话", "全部会话按更新时间排，正在跑的一轮会标出来。"],
      ["发指令", "进一个会话直接发；运行中可以追加，也可以停止这一轮。"],
      ["看到卡在哪", "一轮停在提问上会标「等你回答」，点进去能看到它在等什么。"],
      ["审批仍在电脑", "权限确认、问答与计划批准要在这一台上点，手机只负责让你先知道。"],
    ];
    const list = el("dl", "rm-facts");
    for (const [term, detail] of rows) {
      list.append(el("dt", "", term));
      list.append(el("dd", "", detail));
    }
    card.append(list);
    return card;
  }

  function render() {
    const host = root();
    if (!host) return;
    host.replaceChildren();
    const status = state.status;

    if (status) host.append(statusBar(status));

    const scroll = el("div", "rm-scroll");
    const body = el("main", "rm-body");

    if (state.error) {
      const box = el("div", "opt-error", state.error);
      box.setAttribute("role", "alert");
      body.append(box);
    }
    if (state.flash) {
      const note = el("p", "rm-flash", state.flash);
      note.setAttribute("role", "status");
      body.append(note);
    }

    if (!status) {
      if (!state.error) {
        const skeleton = el("div", "skeleton");
        skeleton.append(el("i"), el("i"), el("i"));
        body.append(skeleton);
      }
      scroll.append(body);
      host.append(scroll);
      return;
    }

    if (status.running) {
      const columns = el("div", "rm-columns");
      const primary = el("div", "rm-column rm-column-main");
      primary.append(qrCard(status), devicesCard(status));
      const secondary = el("div", "rm-column rm-column-side");
      secondary.append(aboutCard());
      columns.append(primary, secondary);
      body.append(columns);
    } else {
      const single = el("div", "rm-single");
      single.append(emptyCard(), aboutCard());
      body.append(single);
    }

    scroll.append(body);
    host.append(scroll);
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    load();
    // The pairing code lives here and nowhere else, so the page keeps it fresh
    // while it is open: a code read out an hour ago is no longer the code.
    state.timer = setInterval(() => {
      const host = root();
      if (host && !host.hidden && !state.busy) load();
    }, 15000);
  }

  window.PiOptRemote = { boot, _state: state, _load: load };
})();
