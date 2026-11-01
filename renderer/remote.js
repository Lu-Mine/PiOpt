/*
 * 手机 view. One page, one job: turn the LAN gateway on and off, and hand out
 * the two things a phone needs — an address and a pairing code.
 *
 * Everything shown here comes from the feature's own status payload; nothing is
 * cached and nothing is guessed. When the gateway is off the rows that only
 * make sense while it runs collapse instead of showing stale numbers.
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

  function button(label, handler, options = {}) {
    const node = el("button", `ui-btn ui-btn-sm ${options.primary ? "ui-btn-primary" : ""} ${options.danger ? "ui-btn-danger" : ""}`.trim(), label);
    node.type = "button";
    node.disabled = Boolean(options.disabled);
    node.addEventListener("click", handler);
    return node;
  }

  function row(title, control, detail) {
    const wrapper = el("div", "settings-row");
    const copy = el("div", "settings-row-copy");
    copy.append(el("div", "settings-row-title", title));
    if (detail) copy.append(el("div", "settings-row-detail", detail));
    wrapper.append(copy, control);
    return wrapper;
  }

  function switchRow({ id, title, detail, checked, onChange }) {
    const label = el("label", "settings-row switch-row");
    label.htmlFor = id;
    const copy = el("span", "settings-row-copy");
    copy.append(el("span", "settings-row-title", title));
    if (detail) copy.append(el("span", "settings-row-detail", detail));
    const control = el("span", "settings-row-control");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));
    const track = el("span", "switch");
    track.setAttribute("aria-hidden", "true");
    track.append(el("span"));
    control.append(input, track);
    label.append(copy, control);
    return label;
  }

  function statusChip(text, tone) {
    const chip = el("span", `ui-chip rm-chip${tone ? ` rm-chip-${tone}` : ""}`, text);
    return chip;
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
      if (state.flash === text) {
        state.flash = "";
        render();
      }
    }, 1800);
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

  // ------------------------------------------------------------------- sections

  function accessSection(status) {
    const section = el("section", "appearance-section");
    const head = el("header", "appearance-heading");
    const copy = el("div");
    copy.append(el("h1", "", "手机控制"));
    copy.append(el("p", "", "同一局域网里的手机可以看会话、发指令、停止运行。"));
    head.append(copy);
    head.append(statusChip(status.running ? "运行中" : "已关闭", status.running ? "on" : "off"));
    section.append(head);

    const group = el("div", "settings-group");
    group.append(
      switchRow({
        id: "rm-toggle",
        title: "开启手机控制",
        detail: "关闭后端口不再监听，已配对的手机也连不上",
        checked: status.running,
        onChange: (checked) => {
          act("toggle", () => invoke(checked ? "remote.start" : "remote.stop"));
        },
      })
    );

    if (status.running) {
      const addresses = Array.isArray(status.addresses) ? status.addresses : [];
      const primary = status.url || (addresses[0] && addresses[0].url) || "";
      const urlValue = el("div", "settings-row-detail rm-url", primary);
      const urlCopy = el("div", "settings-row-copy");
      urlCopy.append(el("div", "settings-row-title", "访问地址"));
      urlCopy.append(urlValue);
      if (addresses.length > 1) {
        const extra = el("div", "settings-row-detail rm-url-extra", addresses.slice(1).map((item) => item.url).join("  ·  "));
        urlCopy.append(extra);
      }
      const urlControl = el("div", "settings-row-control");
      urlControl.append(
        button("复制", async () => {
          const ok = await copyText(primary);
          flash(ok ? "地址已复制" : "复制失败，请手动输入");
        })
      );
      const urlRow = el("div", "settings-row rm-url-row");
      urlRow.append(urlCopy, urlControl);
      group.append(urlRow);

      const codeRow = el("div", "settings-row rm-code-row");
      const codeCopy = el("div", "settings-row-copy");
      codeCopy.append(el("div", "settings-row-title", "配对码"));
      codeCopy.append(el("div", "settings-row-detail", "在手机上输入一次即可长期使用"));
      const codeControl = el("div", "settings-row-control rm-code-control");
      codeControl.append(el("output", "rm-code", status.code || "------"));
      codeControl.append(
        button("换一个", () => act("code", () => invoke("remote.rotateCode")), { disabled: Boolean(state.busy) })
      );
      codeRow.append(codeCopy, codeControl);
      group.append(codeRow);
    }

    const portInput = document.createElement("input");
    portInput.type = "number";
    portInput.min = "1024";
    portInput.max = "65535";
    portInput.className = "rm-port";
    portInput.value = state.portDraft || String(status.configuredPort);
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
    const portControl = el("div", "settings-row-control");
    portControl.append(portInput);
    group.append(row("端口", portControl, status.running ? "改端口会重启一次网关" : "手机访问地址里的端口号"));

    section.append(group);
    return section;
  }

  function devicesSection(status) {
    const section = el("section", "appearance-section");
    const head = el("header", "appearance-heading");
    const copy = el("div");
    copy.append(el("h1", "", "已配对设备"));
    copy.append(el("p", "", "取消后这台手机需要重新配对。"));
    head.append(copy);
    section.append(head);

    const group = el("div", "settings-group");
    const devices = Array.isArray(status.devices) ? status.devices : [];
    if (!devices.length) {
      const empty = el("div", "settings-row");
      const copyBox = el("div", "settings-row-copy");
      copyBox.append(el("div", "settings-row-title", "还没有设备"));
      copyBox.append(el("div", "settings-row-detail", "手机配对后会出现在这里"));
      empty.append(copyBox);
      group.append(empty);
    } else {
      for (const device of devices) {
        const control = el("div", "settings-row-control");
        control.append(
          button("移除", () => {
            act("revoke", () => invoke("remote.revoke", { name: device.name, createdAt: device.createdAt }));
          }, { disabled: Boolean(state.busy) })
        );
        const when = device.lastSeenAt || device.createdAt;
        const detail = when ? `${device.token} · ${new Date(when).toLocaleString()}` : device.token;
        group.append(row(device.name || "手机", control, detail));
      }
    }
    section.append(group);
    return section;
  }

  function notesSection() {
    const section = el("section", "appearance-section");
    const head = el("header", "appearance-heading");
    const copy = el("div");
    copy.append(el("h1", "", "能做什么"));
    head.append(copy);
    section.append(head);

    const group = el("div", "settings-group");
    const list = el("div", "settings-row rm-notes-row");
    const body = el("div", "rm-notes");
    for (const line of [
      "看会话列表与对话内容，给任意会话发指令，停止正在运行的一轮。",
      "工具权限确认与计划审批不开放：这些需要在这台电脑上当面确认，手机端只能看到它们在等。",
      "网关只在打开的这段时间里监听，且只接受配对过的设备。",
    ]) {
      body.append(el("p", "", line));
    }
    list.append(body);
    group.append(list);
    section.append(group);
    return section;
  }

  function render() {
    const host = root();
    if (!host) return;
    host.replaceChildren();
    const scroll = el("div", "rm-scroll");
    const workspace = el("main", "workspace");
    const status = state.status;

    if (state.error) {
      const box = el("div", "opt-error", state.error);
      box.setAttribute("role", "alert");
      workspace.append(box);
    }
    if (state.flash) {
      const note = el("p", "rm-flash", state.flash);
      note.setAttribute("role", "status");
      workspace.append(note);
    }

    if (status) {
      workspace.append(accessSection(status), devicesSection(status), notesSection());
    } else if (!state.error) {
      const loading = el("div", "skeleton");
      loading.append(el("i"), el("i"), el("i"));
      workspace.append(loading);
    }

    scroll.append(workspace);
    host.append(scroll);
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    load();
    // The panel is the only place the pairing code exists outside the phone, so
    // it refreshes while it is open: a code read out loud an hour ago is gone.
    state.timer = setInterval(() => {
      const host = root();
      if (host && !host.hidden && !state.busy) load();
    }, 15000);
  }

  window.PiOptRemote = { boot, _state: state, _load: load };
})();
