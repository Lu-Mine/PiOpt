(function () {
  "use strict";
      const bridge = window.pluginBridge;
      const $ = sel => document.querySelector(sel);

      const TEXT = {
        zh: {
          tabs: { updates: '可用更新', installed: '已安装', available: '可安装', queue: '下载队列' },
          prepareAll: '准备全部',
          refresh: '刷新目录',
          search: '按名称、id 或作者过滤…',
          host: '本机',
          catalogOk: n => `目录 ${n} 个插件`,
          catalogMissing: '目录不可用',
          updateChip: n => `${n} 个更新`,
          noUpdates: '已是最新',
          col: { plugin: '插件', version: '版本', size: '大小', date: '发布', actions: '操作' },
          empty: {
            updates: ['没有可用更新', '已安装的插件都是最新版本。可以刷新目录再看一次。'],
            installed: ['没有已安装插件', '还没有安装任何插件。'],
            available: ['没有可安装的插件', '目录里的插件都已安装，或目录为空。'],
            queue: ['队列是空的', '在更新或已安装列表里点「准备」，下载会出现在这里。'],
          },
          btn: {
            prepare: '准备', retry: '重试', cancel: '取消', copy: '复制', copied: '已复制',
            verify: '校验', remove: '删除', probe: '诊断', detail: '详情', hide: '收起',
            installHint: '去 Plugins 页安装', preparing: '准备中…', ready: '已就绪',
          },
          st: {
            downloading: '下载中', verifying: '校验中', queued: '排队中', done: '已校验',
            failed: '失败', cancelled: '已取消', existing: '已存在',
          },
          label: {
            sha: 'sha256', size: '大小', source: '来源', catalog: 'catalog', downloaded: '本地文件',
            permissions: '权限', changelog: '更新说明', attempts: '尝试记录', probeTitle: '连接诊断',
            dataDir: '下载位置', mirror: '镜像', registry: 'registry', catalogPath: '目录文件', hosts: '允许来源',
          },
          msg: {
            refreshOk: r => `目录已更新：${r.plugins} 个插件，${(r.bytes / 1024).toFixed(0)} KB`,
            refreshFail: m => `目录刷新失败：${m}`,
            prepareFail: m => `准备失败：${m}`,
            busy: '已在进行中',
            copyFail: '复制失败，请手动选中路径',
            removed: '已删除下载的包',
            verifyOk: '校验通过',
            verifyBad: d => `校验不符：${d}`,
            probeFail: m => `诊断失败：${m}`,
            noBridge: '这个面板必须在 PI-Desktop 中打开',
            gaveUp: '下载失败，所有来源都不可用。展开「尝试记录」查看详情。',
          },
          time: '刚刚',
          modal: {
            close: '关闭',
            error: '无法读取详情',
            home: '主页',
            source: '源码',
            repo: '仓库',
            commit: '提交',
            builder: '构建者',
            safety: '安全说明',
            permissions: '权限',
            versions: '版本列表',
            readme: '说明文档',
            noReadme: '这个插件没有说明文档。',
            installed: '本机已安装',
            notInstalled: '本机未安装',
            yanked: '已撤回',
            probe: '诊断',
            probing: '诊断中…',
            prepare: '准备',
            reprepare: '重新下载',
            copy: '复制路径',
            view: '查看',
            viewing: '已选',
            risk: { high: '高风险', medium: '中风险', low: '低风险' },
          },
        },
        en: {
          tabs: { updates: 'Updates', installed: 'Installed', available: 'Available', queue: 'Queue' },
          prepareAll: 'Prepare all',
          refresh: 'Refresh catalog',
          search: 'Filter by name, id or author…',
          host: 'local',
          catalogOk: n => `${n} plugins`,
          catalogMissing: 'Catalog unavailable',
          updateChip: n => `${n} update${n === 1 ? '' : 's'}`,
          noUpdates: 'Up to date',
          col: { plugin: 'Plugin', version: 'Version', size: 'Size', date: 'Published', actions: 'Actions' },
          empty: {
            updates: ['No updates', 'Everything installed is up to date. Refresh to check again.'],
            installed: ['Nothing installed', 'No plugins installed yet.'],
            available: ['Nothing available', 'Everything in the catalog is installed, or the catalog is empty.'],
            queue: ['Queue is empty', 'Press Prepare on an update or an installed plugin; downloads show up here.'],
          },
          btn: {
            prepare: 'Prepare', retry: 'Retry', cancel: 'Cancel', copy: 'Copy', copied: 'Copied',
            verify: 'Verify', remove: 'Delete', probe: 'Probe', detail: 'Details', hide: 'Hide',
            installHint: 'Install from Plugins', preparing: 'Preparing…', ready: 'Ready',
          },
          st: {
            downloading: 'downloading', verifying: 'verifying', queued: 'queued', done: 'verified',
            failed: 'failed', cancelled: 'cancelled', existing: 'already here',
          },
          label: {
            sha: 'sha256', size: 'size', source: 'source', catalog: 'catalog', downloaded: 'local file',
            permissions: 'permissions', changelog: 'changelog', attempts: 'attempts', probeTitle: 'connection check',
            dataDir: 'downloads', mirror: 'mirror', registry: 'registry', catalogPath: 'catalog file', hosts: 'allowed sources',
          },
          msg: {
            refreshOk: r => `Catalog refreshed: ${r.plugins} plugins, ${(r.bytes / 1024).toFixed(0)} KB`,
            refreshFail: m => `Catalog refresh failed: ${m}`,
            prepareFail: m => `Prepare failed: ${m}`,
            busy: 'already running',
            copyFail: 'Copy failed; select the path manually',
            removed: 'Downloaded package deleted',
            verifyOk: 'Verified',
            verifyBad: d => `Mismatch: ${d}`,
            probeFail: m => `Probe failed: ${m}`,
            noBridge: 'This panel must be opened inside PI-Desktop',
            gaveUp: 'Download failed: no source was reachable. Open “attempts” for details.',
          },
          time: 'now',
          modal: {
            close: 'Close',
            error: 'Could not load details',
            home: 'Homepage',
            source: 'Source',
            repo: 'Repository',
            commit: 'Commit',
            builder: 'Builder',
            safety: 'Safety notes',
            permissions: 'Permissions',
            versions: 'Versions',
            readme: 'Readme',
            noReadme: 'This plugin has no readme.',
            installed: 'Installed',
            notInstalled: 'Not installed',
            yanked: 'yanked',
            probe: 'Diagnose',
            probing: 'Probing…',
            prepare: 'Prepare',
            reprepare: 'Download again',
            copy: 'Copy path',
            view: 'View',
            viewing: 'Selected',
            risk: { high: 'High', medium: 'Medium', low: 'Low' },
          },
        },
      };

      let LANG = 'zh';
      const state = {
        snapshot: null,
        jobs: [],
        tab: 'installed',
        q: '',
        open: new Set(),
        probes: {},
        notices: [],
        loading: true,
        error: null,
        detail: null,
      };

      let pollTimer = null;

      const tr = (path, ...args) => {
        const parts = String(path).split('.');
        let value = TEXT[LANG];
        for (const part of parts) value = value?.[part];
        if (typeof value === 'function') return value(...args);
        return value ?? path;
      };
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const bytes = n => {
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
        if (n < 1024) return `${n} B`;
        const units = ['KB', 'MB', 'GB'];
        let v = n / 1024;
        let i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
        return `${v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
      };
      const day = ms => {
        if (!ms) return '—';
        try {
          return new Intl.DateTimeFormat(LANG === 'zh' ? 'zh-CN' : 'en', { month: '2-digit', day: '2-digit' }).format(new Date(ms));
        } catch { return '—'; }
      };
      const stamp = ms => {
        if (!ms) return '—';
        try {
          return new Intl.DateTimeFormat(LANG === 'zh' ? 'zh-CN' : 'en', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
        } catch { return '—'; }
      };
      const shortSha = sha => (typeof sha === 'string' && sha.length >= 16 ? `${sha.slice(0, 10)}…${sha.slice(-4)}` : (sha || '—'));
      const matches = item => {
        if (!state.q) return true;
        const q = state.q.toLowerCase();
        return [item.id, item.name, item.localName, item.author, item.description].some(v => typeof v === 'string' && v.toLowerCase().includes(q));
      };
      const jobOf = (id, version) => state.jobs.find(job => job.id === id && (!version || job.version === version));
      // Downloader phases are not display keys: download → downloading, verify → verifying.
      const PHASE_KEY = {
        queued: 'queued', source: 'queued', download: 'downloading', verify: 'verifying',
        'failed-attempt': 'failed', done: 'done', failed: 'failed', cancelled: 'cancelled',
      };
      const phaseLabel = job => (TEXT[LANG].st[PHASE_KEY[job.phase] || job.phase] || job.phase);

      async function rpc(channel, payload = {}) {
        if (!bridge?.invoke) throw new Error(tr('msg.noBridge'));
        return await bridge.invoke(channel, payload);
      }

      function notice(message, kind = '') {
        state.notices.push({ id: Math.random().toString(36).slice(2), message, kind });
        renderNotice();
        setTimeout(() => {
          state.notices = state.notices.filter(n => n.message !== message);
          renderNotice();
        }, 6000);
      }

      function renderNotice() {
        $('#notice').innerHTML = state.notices.slice(-2).map(n => `
          <div class="${esc(n.kind)}"><span style="flex:1">${esc(n.message)}</span></div>
        `).join('');
      }

      function renderChrome() {
        const snap = state.snapshot;
        const notes = TEXT[LANG];
        $('#hostVersion').textContent = snap ? `v${snap.hostVersion}` : '';
        document.title = 'Pimarket';
        $('#btnRefresh').textContent = notes.refresh;
        $('#btnPrepareAll').textContent = notes.prepareAll;
        $('#q').placeholder = notes.search;

        const catalogChip = $('#catalogChip');
        const stats = snap?.stats || { updates: 0, installed: 0, available: 0 };
        if (!snap) {
          catalogChip.className = 'chip';
          catalogChip.innerHTML = `<span class="dot"></span><span>${esc(notes.catalogMissing)}</span>`;
        } else if (!snap.catalog.ok) {
          catalogChip.className = 'chip bad';
          catalogChip.innerHTML = `<span class="dot bad"></span><span>${esc(notes.catalogMissing)}</span>`;
          catalogChip.title = snap.catalog.error || '';
        } else {
          catalogChip.className = 'chip';
          catalogChip.innerHTML = `<span class="dot ok"></span><span>${esc(notes.catalogOk(snap.catalog.pluginCount))}</span>`;
          catalogChip.title = `${snap.catalog.path}${snap.catalog.mtimeMs ? ` · ${stamp(snap.catalog.mtimeMs)}` : ''}`;
        }

        const updateChip = $('#updateChip');
        if (stats.updates > 0) {
          updateChip.className = 'chip warn';
          updateChip.innerHTML = `<span class="dot warn"></span><b>${stats.updates}</b><span>${esc(notes.updateChip(stats.updates).replace(`${stats.updates} `, ''))}</span>`;
          updateChip.title = snap.updates.map(item => `${item.id} ${item.version} → ${item.catalogVersion}`).join('\n');
        } else {
          updateChip.className = 'chip';
          updateChip.innerHTML = `<span class="dot ok"></span><span>${esc(notes.noUpdates)}</span>`;
          updateChip.title = '';
        }

        $('#btnPrepareAll').disabled = !snap || stats.updates === 0;

        const rail = $('#rail');
        const tabs = [
          ['installed', stats.installed],
          ['updates', stats.updates],
          ['available', stats.available],
          ['queue', state.jobs.length],
        ];
        rail.innerHTML = tabs.map(([key, count], index) => `
          <button class="tab${index === 0 ? '' : ''}" role="tab" data-tab="${key}" aria-selected="${state.tab === key}">
            <span>${esc(notes.tabs[key])}</span><span class="count">${count}</span>
          </button>
        `).join('') + `
          <div class="rail-foot">
            <div title="${esc(snap?.mirror?.repo || '')}">${esc(notes.label.mirror)} · <code>@${esc(snap?.mirror?.ref || '—')}</code></div>
            <button data-action="copy" data-copy="${esc(snap?.downloadsDir || '')}" title="${esc(snap?.downloadsDir || '')}">${esc(notes.label.dataDir)} · ${esc(notes.btn.copy)}</button>
            <div style="opacity:.75" title="${esc((snap?.mirror?.allowedHosts || []).join(' · '))}">${esc(notes.label.hosts)} ${(snap?.mirror?.allowedHosts || []).length}</div>
          </div>
        `;
      }

      function rowActions(item, version, job) {
        const notes = TEXT[LANG];
        const ready = item.downloaded && item.downloaded.sizeMatches === true;
        const detail = `<button class="ui-btn ui-btn-sm" data-action="detail" data-id="${esc(item.id)}">${esc(notes.btn.detail)}</button>`;
        if (job && job.status === 'running') {
          return `
            ${detail}
            <button class="ui-btn ui-btn-sm ui-btn-danger" data-action="cancel" data-key="${esc(job.key)}">${esc(notes.btn.cancel)}</button>
          `;
        }
        if (ready) {
          return `
            ${detail}
            <button class="ui-btn ui-btn-sm" data-action="copy" data-copy="${esc(item.downloaded.path)}">${esc(notes.btn.copy)}</button>
            <button class="ui-btn ui-btn-sm" data-action="verify" data-id="${esc(item.id)}" data-version="${esc(version)}">${esc(notes.btn.verify)}</button>
            <button class="ui-btn ui-btn-sm ui-btn-danger" data-action="remove" data-id="${esc(item.id)}" data-version="${esc(version)}">${esc(notes.btn.remove)}</button>
          `;
        }
        return `
          ${detail}
          <button class="ui-btn ui-btn-sm" data-action="probe" data-id="${esc(item.id)}" data-version="${esc(version)}">${esc(notes.btn.probe)}</button>
          <button class="ui-btn ui-btn-sm ui-btn-primary" data-action="prepare" data-id="${esc(item.id)}" data-version="${esc(version)}">${esc(notes.btn.prepare)}</button>
        `;
      }

      function renderProgress(job) {
        if (!job || job.status !== 'running') return '';
        const percent = job.percent === null ? null : job.percent;
        const status = `${phaseLabel(job)}${job.percent !== null ? ` ${job.percent}%` : ''}`;
        const detail = `${job.sourceLabel || job.source ? ` · ${job.sourceLabel || job.source}` : ''}${job.total ? ` · ${bytes(job.received)} / ${bytes(job.total)}` : ''}${job.attempt ? ` · #${job.attempt}` : ''}`;
        return `
          <div class="progress" data-progress="${esc(job.key)}">
            <div class="bar"><i style="width:${percent === null ? 8 : percent}%"></i></div>
            <span class="txt">${esc(status)}${esc(detail)}</span>
          </div>
        `;
      }
      function renderDetail(item, version) {
        const notes = TEXT[LANG];
        const key = `${item.id}@${version}`;
        if (!state.open.has(key)) return '';
        const latest = item.latest || {};
        const blocks = [];
        blocks.push(`
          <div class="detail">
            <h4>${esc(notes.label.changelog)}</h4>
            <pre>${esc(latest.changelog || '—')}</pre>
          </div>
        `);
        blocks.push(`
          <div class="detail">
            <h4>${esc(notes.label.sha)}</h4>
            <div class="kv">
              <span>${esc(notes.label.sha)}</span><span>${esc(latest.sha256 || '—')}</span>
              <span>${esc(notes.label.size)}</span><span>${bytes(latest.sizeBytes)}</span>
              <span>${esc(notes.label.catalog)}</span><span>${esc(latest.publishedAt || '—')}</span>
              <span>${esc(notes.label.permissions)}</span><span>${esc((latest.permissions || []).join(', ') || '—')}</span>
              <span>${esc(notes.label.downloaded)}</span><span>${esc(item.downloaded?.path || '—')}</span>
            </div>
          </div>
        `);
        const job = jobOf(item.id, version);
        if (job && job.attempts && job.attempts.length) {
          blocks.push(`
            <div class="detail">
              <h4>${esc(notes.label.attempts)}</h4>
              <table class="probe">
                <tr><th>#</th><th>${esc(notes.label.source)}</th><th>code</th><th>message</th></tr>
                ${job.attempts.map(a => `<tr><td>${a.attempt ?? ''}</td><td>${esc(a.source || '')}</td><td class="m">${esc(a.code || '')}</td><td class="m">${esc(a.message || '')}</td></tr>`).join('')}
              </table>
            </div>
          `);
        }
        if (job && job.status === 'failed' && !job.attempts?.length) {
          blocks.push(`<div class="detail"><h4>error</h4><pre>${esc(job.error || '')}</pre></div>`);
        }
        const probe = state.probes[key];
        if (probe) {
          blocks.push(`
            <div class="detail">
              <h4>${esc(notes.label.probeTitle)}</h4>
              <table class="probe">
                <tr><th>${esc(notes.label.source)}</th><th>status</th><th>${esc(notes.col.size)}</th><th>ms</th><th>detail</th></tr>
                ${probe.map(r => `
                  <tr>
                    <td>${esc(r.label || r.id)}</td>
                    <td class="${r.ok ? 'state ok' : 'state bad'}">${r.ok ? 'OK' : esc(r.code || r.status || '—')}</td>
                    <td class="num">${r.contentLength ? bytes(r.contentLength) : '—'}</td>
                    <td class="num">${r.elapsedMs ?? '—'}</td>
                    <td class="m">${esc(r.message || r.head || r.contentType || '')}</td>
                  </tr>
                `).join('')}
              </table>
            </div>
          `);
        }
        return blocks.join('');
      }

      function renderUpdates() {
        const notes = TEXT[LANG];
        const items = state.snapshot?.updates || [];
        if (!items.length) return emptyState('updates');
        return `
          <div class="list-head updates">
            <span>${esc(notes.col.plugin)}</span><span>${esc(notes.col.version)}</span>
            <span>${esc(notes.col.size)}</span><span>${esc(notes.col.date)}</span><span></span>
          </div>
          ${items.filter(matches).map(item => {
            const version = item.latest?.version;
            const job = jobOf(item.id, version);
            const ready = item.downloaded?.sizeMatches === true && job?.status !== 'running';
            const cls = ['row', 'updates', item.updateAvailable ? 'has-update' : '', ready ? 'is-ready' : '', job?.status === 'failed' ? 'is-failed' : ''].join(' ');
            return `
              <article class="${cls}">
                <div class="name">
                  <b>${esc(item.localName || item.name)}</b>
                  <span class="id mono">${esc(item.id)}</span>
                  ${item.bundled ? `<span class="badge bundled">bundled</span>` : ''}
                  ${item.enabled === false ? `<span class="badge off">disabled</span>` : ''}
                </div>
                <div class="ver num">
                  <span class="from">${esc(item.version)}</span><span class="arrow">→</span><span class="to">${esc(version)}</span>
                </div>
                <div class="size num">${bytes(item.latest?.sizeBytes)}</div>
                <div class="date num">${day(item.latest?.publishedAt)}</div>
                <div class="actions">${rowActions(item, version, job)}</div>
                ${renderProgress(job)}
                ${renderDetail(item, version)}
              </article>
            `;
          }).join('')}
        `;
      }

      function renderInstalled() {
        const notes = TEXT[LANG];
        const items = (state.snapshot?.installed || []).filter(matches);
        if (!items.length) return emptyState('installed');
        return `
          <div class="list-head installed">
            <span>${esc(notes.col.plugin)}</span><span>${esc(notes.col.version)}</span>
            <span>${esc(notes.col.actions)}</span>
          </div>
          ${items.map(item => {
            const version = item.version;
            const job = jobOf(item.id, version);
            const ready = item.downloaded?.sizeMatches === true && item.downloaded?.path?.includes(`-${version}.piplug`) && job?.status !== 'running';
            const detailVersion = item.updateAvailable ? item.latest?.version : version;
            const cls = ['row', 'installed', item.updateAvailable ? 'has-update' : '', ready ? 'is-ready' : ''].join(' ');
            return `
              <article class="${cls}">
                <div class="name">
                  <b>${esc(item.localName || item.name)}</b>
                  <span class="id mono">${esc(item.id)}</span>
                  ${item.bundled ? `<span class="badge bundled">bundled</span>` : ''}
                  ${item.enabled === false ? `<span class="badge off">disabled</span>` : ''}
                  ${!item.inCatalog ? `<span class="badge">not in catalog</span>` : ''}
                </div>
                <div class="ver num">
                  <span class="${item.updateAvailable ? 'from' : 'current'}">${esc(version)}</span>
                  ${item.updateAvailable ? `<span class="arrow">→</span><span class="to">${esc(item.latest.version)}</span>` : ''}
                </div>
                <div class="actions">
                  ${item.inCatalog ? `
                    ${rowActions(item, item.updateAvailable ? item.latest?.version : version, job)}
                  ` : `<span class="state">—</span>`}
                </div>
                ${renderProgress(job)}
                ${renderDetail(item, detailVersion)}
              </article>
            `;
          }).join('')}
        `;
      }

      function renderAvailable() {
        const notes = TEXT[LANG];
        const items = (state.snapshot?.available || []).filter(matches);
        if (!items.length) return emptyState('available');
        return `
          <div class="cards">
            ${items.map(item => {
              const version = item.latest?.version;
              const job = jobOf(item.id, version);
              const ready = item.downloaded?.sizeMatches === true;
              return `
                <article class="card">
                  <div>
                    <h3>${esc(item.name)}</h3>
                    <div class="id mono">${esc(item.id)}</div>
                  </div>
                  <p>${esc(item.description || '')}</p>
                  <div class="foot">
                    <span class="meta num">${esc(version)} · ${bytes(item.latest?.sizeBytes)}</span>
                    <span class="btns">
                      ${ready
                        ? `<button class="ui-btn ui-btn-sm" data-action="copy" data-copy="${esc(item.downloaded.path)}">${esc(notes.btn.copy)}</button>`
                        : `<button class="ui-btn ui-btn-sm ui-btn-primary" data-action="prepare" data-id="${esc(item.id)}" data-version="${esc(version)}">${esc(notes.btn.prepare)}</button>`}
                      <button class="ui-btn ui-btn-sm" data-action="detail" data-id="${esc(item.id)}">${esc(notes.btn.detail)}</button>
                      <button class="ui-btn ui-btn-sm" data-action="probe" data-id="${esc(item.id)}" data-version="${esc(version)}">${esc(notes.btn.probe)}</button>
                    </span>
                  </div>
                  ${renderProgress(job)}
                </article>
              `;
            }).join('')}
          </div>
        `;
      }

      function renderQueue() {
        const notes = TEXT[LANG];
        const items = state.jobs.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        if (!items.length) return emptyState('queue');
        const label = job => {
          if (job.status === 'ready') return notes.st.done;
          if (job.status === 'failed') return notes.st.failed;
          if (job.status === 'cancelled') return notes.st.cancelled;
          return phaseLabel(job);
        };
        return items.map(job => `
          <div class="qrow">
            <div>
              <div class="name">
                <b>${esc(job.id)}</b>
                <span class="id mono">${esc(job.version)}${job.sourceLabel ? ` · ${esc(job.sourceLabel)}` : ''}</span>
              </div>
              ${job.error ? `<div class="err">${esc(job.error)}</div>` : ''}
              ${job.lastError && !job.error && job.status !== 'ready' ? `<div class="err" style="opacity:.7">${esc(job.lastError)}</div>` : ''}
              ${job.status === 'failed' && Array.isArray(job.attempts) && job.attempts.length ? `
                <div class="err" style="color:var(--ds-text-muted)">${job.attempts.slice(-4).map(a => `${esc(a.source)}: ${esc(a.code)}`).join('  ·  ')}${job.attempts.length > 4 ? `  ·  +${job.attempts.length - 4}` : ''}</div>
              ` : ''}
              ${job.status === 'running' || job.status === 'ready' ? `
              <div class="progress" data-progress="${esc(job.key)}">
                <div class="bar"><i style="width:${job.percent ?? (job.status === 'ready' ? 100 : 4)}%"></i></div>
              </div>
              ` : ''}
            </div>
            <div class="state ${job.status === 'ready' ? 'ok' : job.status === 'failed' ? 'bad' : ''}">
              <span class="dot ${job.status === 'ready' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}"></span>
              ${esc(label(job))}${job.percent !== null && job.status === 'running' ? ` ${job.percent}%` : ''}
            </div>
            <div class="actions">
              ${job.status === 'running'
                ? `<button class="ui-btn ui-btn-sm ui-btn-danger" data-action="cancel" data-key="${esc(job.key)}">${esc(notes.btn.cancel)}</button>`
                : job.path
                  ? `<button class="ui-btn ui-btn-sm" data-action="copy" data-copy="${esc(job.path)}">${esc(notes.btn.copy)}</button>`
                  : ''}
              ${job.status !== 'running' && job.code
                ? `<button class="ui-btn ui-btn-sm" data-action="prepare" data-id="${esc(job.id)}" data-version="${esc(job.version)}">${esc(notes.btn.retry)}</button>`
                : ''}
            </div>
          </div>
        `).join('');
      }

      function emptyState(kind) {
        const [title, body] = tr(`empty.${kind}`) || ['', ''];
        const icon = kind === 'queue'
          ? '<path d="M2 5h12M2 11h12" stroke-linecap="round"/>'
          : kind === 'available'
            ? '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8h5M8 5.5v5" stroke-linecap="round"/>'
            : '<circle cx="8" cy="8" r="6"/><path d="m5.5 8 1.8 1.8L10.8 6.3" stroke-linecap="round" stroke-linejoin="round"/>';
        return `
          <div class="empty">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">${icon}</svg>
            <b>${esc(title)}</b>
            <p>${esc(body)}</p>
          </div>
        `;
      }

      // ---------------------------------------------------------------- detail

      const riskText = risk => (TEXT[LANG].modal.risk[risk] || risk);

      function closeDetail() {
        state.detail = null;
        $('#veil').hidden = true;
        $('#modalBox').innerHTML = '';
      }

      function detailVersion() {
        const detail = state.detail;
        if (!detail?.data) return null;
        const versions = detail.data.versions || [];
        return versions.find(entry => entry.version === detail.version) || versions[0] || null;
      }

      async function openDetail(id, options = {}) {
        state.detail = { id, loading: true, data: null, error: null, version: null, probe: null, probeBusy: false };
        renderModal();
        try {
          const data = await rpc('market.detail', { id });
          if (!data || data.ok !== true) throw new Error(data?.message || 'detail unavailable');
          state.detail.data = data;
          state.detail.version = data.plugin.latestVersion || data.versions?.[0]?.version || null;
          state.detail.loading = false;
          renderModal();
          if (options.probe) await runDetailProbe();
        } catch (error) {
          state.detail.loading = false;
          state.detail.error = String(error?.message || error);
          renderModal();
        }
      }

      async function runDetailProbe() {
        const detail = state.detail;
        const version = detailVersion();
        if (!detail?.data || !version) return;
        detail.probeBusy = true;
        detail.probe = null;
        renderModal();
        try {
          const result = await rpc('market.probe', { id: detail.data.plugin.id, version: version.version });
          detail.probe = result?.ok ? result.results : [{ id: 'probe', label: 'probe', ok: false, message: result?.message || '' }];
        } catch (error) {
          detail.probe = [{ id: 'probe', label: 'probe', ok: false, message: String(error?.message || error) }];
        } finally {
          detail.probeBusy = false;
          renderModal();
        }
      }

      function renderModal() {
        const detail = state.detail;
        const veil = $('#veil');
        const box = $('#modalBox');
        if (!detail) {
          veil.hidden = true;
          box.innerHTML = '';
          return;
        }
        const notes = TEXT[LANG].modal;
        veil.hidden = false;
        if (detail.loading) {
          box.innerHTML = `<div class="modal-body"><div class="skeleton"><i></i><i></i><i></i></div></div>`;
          return;
        }
        if (detail.error) {
          box.innerHTML = `
            <div class="modal-head">
              <div class="modal-title"><h3>${esc(detail.id)}</h3><div class="sub">${esc(notes.error)}</div></div>
              <button class="icon-btn" data-action="close-detail" aria-label="${esc(notes.close)}">✕</button>
            </div>
            <div class="modal-body"><p>${esc(detail.error)}</p></div>`;
          return;
        }

        const data = detail.data;
        const plugin = data.plugin;
        const version = detailVersion();
        const installed = data.installed;
        const initial = (plugin.name || plugin.id).trim().charAt(0).toUpperCase();
        const provenance = version?.provenance || null;
        const repoUrl = provenance?.sourceRepository || plugin.repository || null;
        const downloaded = version?.downloaded?.sizeMatches === true;

        const versionCard = version ? `
          <div class="vcard">
            <div class="grow">
              <div class="v">v${esc(version.version)}</div>
              <div class="meta">${esc(day(version.publishedAt))} · ${esc(bytes(version.sizeBytes))}${
                installed ? ` · ${esc(notes.installed)} v${esc(installed.version)}` : ` · ${esc(notes.notInstalled)}`}${
                installed?.bundled ? ' · bundled' : ''}</div>
            </div>
            <div class="actions">
              ${downloaded ? `<button class="ui-btn ui-btn-sm" data-action="copy" data-copy="${esc(version.downloaded.path)}">${esc(notes.copy)}</button>` : ''}
              <button class="ui-btn ui-btn-primary" data-action="detail-prepare" data-version="${esc(version.version)}">${
                downloaded ? esc(notes.reprepare) : `${esc(notes.prepare)} v${esc(version.version)}`}</button>
            </div>
          </div>` : '';

        const homeSection = plugin.homepage ? `
          <div class="msec">
            <h5>${esc(notes.home)}</h5>
            <div class="kvrow"><span class="k">URL</span><span class="v"><button data-action="open-link" data-url="${esc(plugin.homepage)}">${esc(plugin.homepage)}</button></span></div>
          </div>` : '';

        const sourceSection = (repoUrl || provenance?.sourceCommit || provenance?.builder) ? `
          <div class="msec">
            <h5>${esc(notes.source)}</h5>
            <div class="kvrow">
              ${repoUrl ? `<span class="k">${esc(notes.repo)}</span><span class="v"><button data-action="open-link" data-url="${esc(repoUrl)}">${esc(repoUrl)}</button></span>` : ''}
              ${provenance?.sourceCommit ? `<span class="k">${esc(notes.commit)}</span><span class="v">${esc(String(provenance.sourceCommit).slice(0, 12))}</span>` : ''}
              ${provenance?.builder ? `<span class="k">${esc(notes.builder)}</span><span class="v">${esc(provenance.builder)}</span>` : ''}
            </div>
          </div>` : '';

        const safetySection = plugin.safetyNotes
          ? `<div class="safety"><strong>${esc(notes.safety)}</strong>${esc(plugin.safetyNotes)}</div>`
          : '';

        const permItems = (version?.permissions || []).flatMap(group => group.items.map(item => `
          <div class="perm">
            <span class="risk ${esc(item.risk)}">${esc(riskText(item.risk))}</span>
            <div>
              <div class="pname">${esc(item.name)}${item.name !== item.id ? `<span class="pid">${esc(item.id)}</span>` : ''}</div>
              ${item.description ? `<p class="pdesc">${esc(item.description)}</p>` : ''}
            </div>
          </div>`)).join('');
        const permSection = permItems
          ? `<div class="msec"><h5>${esc(notes.permissions)}</h5><div class="perms">${permItems}</div></div>`
          : '';

        const versionList = (data.versions || []).map(entry => `
          <div class="ver-item ${entry.version === version?.version ? 'selected' : ''}">
            <div class="head">
              <b>v${esc(entry.version)}</b>
              <span class="date">${esc(day(entry.publishedAt))}</span>
              <span class="size">${esc(bytes(entry.sizeBytes))}</span>
              ${entry.sha256 ? `<span class="sha">${esc(entry.sha256.slice(0, 12))}…</span>` : ''}
              ${entry.yanked ? `<span class="badge">${esc(notes.yanked)}</span>` : ''}
              <button class="pick" data-action="pick-version" data-version="${esc(entry.version)}">${
                entry.version === version?.version ? esc(notes.viewing) : esc(notes.view)}</button>
            </div>
            ${entry.changelog && entry.version === version?.version ? `<pre>${esc(entry.changelog)}</pre>` : ''}
          </div>`).join('');

        const probeTable = detail.probe ? `
          <div class="msec">
            <h5>${esc(notes.probe)}</h5>
            <table class="probe">
              <tr><th>source</th><th>status</th><th>${esc(TEXT[LANG].col.size)}</th><th>ms</th><th>detail</th></tr>
              ${detail.probe.map(row => `
                <tr>
                  <td>${esc(row.label || row.id)}</td>
                  <td class="${row.ok ? 'state ok' : 'state bad'}">${row.ok ? 'OK' : esc(row.code || row.status || '—')}</td>
                  <td class="num">${row.contentLength ? esc(bytes(row.contentLength)) : '—'}</td>
                  <td class="num">${row.elapsedMs ?? '—'}</td>
                  <td class="m">${esc(row.message || row.head || row.contentType || '')}</td>
                </tr>`).join('')}
            </table>
          </div>` : '';

        box.innerHTML = `
          <div class="modal-head">
            <div class="avatar">${esc(initial)}</div>
            <div class="modal-title">
              <h3>${esc(plugin.name)}</h3>
              <div class="sub">${esc(plugin.id)}${plugin.author ? ` · ${esc(plugin.author)}` : ''}</div>
            </div>
            <button class="icon-btn" data-action="close-detail" aria-label="${esc(notes.close)}">✕</button>
          </div>
          <div class="modal-body">
            ${plugin.description ? `<p>${esc(plugin.description)}</p>` : ''}
            ${versionCard}
            ${homeSection}
            ${sourceSection}
            ${safetySection}
            ${permSection}
            <div class="msec"><h5>${esc(notes.versions)}</h5>${versionList}</div>
            ${probeTable}
            <div class="msec"><h5>${esc(notes.readme)}</h5><p class="muted">${esc(notes.noReadme)}</p></div>
          </div>
          <div class="modal-foot">
            <div class="grow">${installed ? `${esc(notes.installed)} v${esc(installed.version)}` : esc(notes.notInstalled)}</div>
            <button class="ui-btn" data-action="detail-probe" ${detail.probeBusy ? 'disabled' : ''}>${esc(detail.probeBusy ? notes.probing : notes.probe)}</button>
            <button class="ui-btn" data-action="close-detail">${esc(notes.close)}</button>
          </div>`;
      }

      function renderView() {
        if (state.loading) return;
        if (state.error) {
          $('#scroll').innerHTML = `<div class="empty"><b>${esc(tr('catalogMissing'))}</b><p>${esc(state.error)}</p></div>`;
          return;
        }
        const map = { updates: renderUpdates, installed: renderInstalled, available: renderAvailable, queue: renderQueue };
        $('#scroll').innerHTML = (map[state.tab] || renderUpdates)();
      }

      function render() {
        renderChrome();
        renderView();
      }

      function patchJobs() {
        for (const job of state.jobs) {
          document.querySelectorAll(`[data-progress="${CSS.escape(job.key)}"]`).forEach(el => {
            const bar = el.querySelector('i');
            if (bar) bar.style.width = `${job.percent ?? (job.status === 'ready' ? 100 : 6)}%`;
            const txt = el.querySelector('.txt');
            if (txt && job.status === 'running') {
              const detail = `${job.sourceLabel || job.source ? ` · ${job.sourceLabel || job.source}` : ''}${job.total ? ` · ${bytes(job.received)} / ${bytes(job.total)}` : ''}${job.attempt ? ` · #${job.attempt}` : ''}`;
              txt.textContent = `${phaseLabel(job)}${job.percent !== null ? ` ${job.percent}%` : ''}${detail}`;
            }
          });
        }
      }

      async function loadSnapshot() {
        try {
          state.snapshot = await rpc('market.snapshot');
          state.jobs = state.snapshot.jobs || state.jobs;
          state.error = null;
          LANG = String(state.snapshot.locale || 'zh').startsWith('zh') ? 'zh' : 'en';
        } catch (error) {
          state.error = String(error?.message || error);
        } finally {
          state.loading = false;
        }
      }

      function ensurePolling() {
        if (pollTimer) return;
        pollTimer = setInterval(async () => {
          let data;
          try {
            data = await rpc('market.jobs');
          } catch {
            clearInterval(pollTimer);
            pollTimer = null;
            return;
          }
          const before = new Map(state.jobs.map(job => [job.key, job.status]));
          state.jobs = data.jobs || [];
          const statusChanged = state.jobs.some(job => before.has(job.key) && before.get(job.key) !== job.status);
          const appeared = state.jobs.some(job => !before.has(job.key));
          patchJobs();
          if (statusChanged || appeared) {
            await loadSnapshot();
            render();
          }
          if (!state.jobs.some(job => job.status === 'running')) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }, 700);
      }

      async function startPrepare(id, version) {
        try {
          const result = await rpc('market.startPrepare', { id, version });
          if (!result?.ok) {
            notice(tr('msg.prepareFail', result?.message || ''), 'bad');
            return;
          }
          if (!state.jobs.some(job => job.key === result.jobKey)) {
            state.jobs.push({ key: result.jobKey, id, version: result.version, status: 'running', phase: 'queued', percent: null });
          }
          ensurePolling();
          render();
        } catch (error) {
          notice(tr('msg.prepareFail', String(error?.message || error)), 'bad');
        }
      }

      async function copyText(text) {
        if (!text) return false;
        try {
          const result = await rpc('market.copyPath', { text });
          if (result?.ok) return true;
        } catch { /* fall through to the browser clipboard */ }
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      }

      document.addEventListener('click', async event => {
        if (event.target.id === 'veil') {
          closeDetail();
          return;
        }
        const tab = event.target.closest('[data-tab]');
        if (tab) {
          state.tab = tab.dataset.tab;
          render();
          if (state.tab === 'queue' && state.jobs.some(job => job.status === 'running')) ensurePolling();
          return;
        }

        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const id = button.dataset.id;
        const version = button.dataset.version;
        const key = button.dataset.key;

        if (action === 'prepare') {
          button.disabled = true;
          button.textContent = tr('btn.preparing');
          await startPrepare(id, version);
          return;
        }

        if (action === 'cancel') {
          try { await rpc('market.cancel', { key }); } catch (error) { notice(String(error?.message || error), 'bad'); }
          return;
        }

        if (action === 'copy') {
          const path = button.dataset.copy;
          const ok = await copyText(path);
          if (!ok) {
            notice(tr('msg.copyFail'), 'bad');
            return;
          }
          const previous = button.textContent;
          button.textContent = tr('btn.copied');
          setTimeout(() => { button.textContent = previous; }, 1200);
          return;
        }

        if (action === 'detail') {
          await openDetail(id);
          return;
        }

        if (action === 'close-detail') {
          closeDetail();
          return;
        }

        if (action === 'pick-version') {
          if (state.detail) {
            state.detail.version = version;
            renderModal();
          }
          return;
        }

        if (action === 'detail-prepare') {
          const detailId = state.detail?.data?.plugin.id;
          closeDetail();
          if (detailId) await startPrepare(detailId, version);
          return;
        }

        if (action === 'detail-probe') {
          await runDetailProbe();
          return;
        }

        if (action === 'open-link') {
          const url = button.dataset.url;
          if (!url) return;
          try {
            await rpc('shell.openExternal', { url });
          } catch {
            await copyText(url);
            notice(tr('btn.copied'), 'ok');
          }
          return;
        }

        if (action === 'probe') {
          await openDetail(id, { probe: true });
          return;
        }

        if (action === 'verify') {
          button.disabled = true;
          try {
            const result = await rpc('market.verify', { id, version });
            if (result?.ok) notice(tr('msg.verifyOk'), 'ok');
            else notice(tr('msg.verifyBad', result?.detail || result?.message || ''), 'bad');
          } catch (error) {
            notice(String(error?.message || error), 'bad');
          } finally {
            button.disabled = false;
          }
          return;
        }

        if (action === 'remove') {
          try {
            const result = await rpc('market.removeDownload', { id, version });
            if (result?.ok) {
              notice(tr('msg.removed'), 'ok');
              await loadSnapshot();
              render();
            } else {
              notice(String(result?.message || ''), 'bad');
            }
          } catch (error) {
            notice(String(error?.message || error), 'bad');
          }
        }
      });

      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.detail) {
          event.preventDefault();
          closeDetail();
        }
      });

      $('#q').addEventListener('input', event => {
        state.q = event.target.value.trim();
        renderView();
      });

      $('#btnRefresh').addEventListener('click', async () => {
        const button = $('#btnRefresh');
        button.disabled = true;
        try {
          const result = await rpc('market.refreshCatalog');
          if (!result?.ok) {
            notice(tr('msg.refreshFail', result?.message || ''), 'bad');
          } else {
            notice(tr('msg.refreshOk', result), 'ok');
            await loadSnapshot();
            render();
          }
        } catch (error) {
          notice(tr('msg.refreshFail', String(error?.message || error)), 'bad');
        } finally {
          button.disabled = false;
        }
      });

      $('#btnPrepareAll').addEventListener('click', async () => {
        const button = $('#btnPrepareAll');
        button.disabled = true;
        try {
          const result = await rpc('market.startPrepareAll');
          if (!result?.ok) {
            notice(tr('msg.prepareFail', result?.message || ''), 'bad');
            return;
          }
          state.tab = 'queue';
          ensurePolling();
          await loadSnapshot();
          render();
        } catch (error) {
          notice(tr('msg.prepareFail', String(error?.message || error)), 'bad');
        } finally {
          button.disabled = false;
        }
      });

      async function applyAppearance(appearance) {
        const base = appearance?.base === 'light' || appearance?.base === 'dark'
          ? appearance.base
          : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        document.documentElement.dataset.base = base;
        if (typeof appearance?.locale === 'string' && appearance.locale) {
          LANG = appearance.locale.startsWith('zh') ? 'zh' : 'en';
          document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
          if (state.snapshot) render();
        }
      }

      async function boot() {
        bridge?.on?.('appearance:changed', applyAppearance);
        try { applyAppearance(await rpc('app.getAppearance')); } catch { applyAppearance(null); }
        await loadSnapshot();
        render();
        if (state.jobs.some(job => job.status === 'running')) ensurePolling();
      }

      window.PiOptMarket = { boot };
})();
