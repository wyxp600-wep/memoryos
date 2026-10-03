/* =====================================================================
 * canvas-editor.js — 节点画布（P0，2026-10-04）
 * 交互：先建卡后选型（D11）—— 单入口"＋ 卡片"落中性文档卡，卡上徽标改选类型；
 *       自定义类型走 /api/card-types 注册表；连线方向按行为档位判定。
 * 自包含设计：独立容器/平移缩放/定时刷新，不与旧任务地图渲染器抢 DOM；
 *       位置持久化复用 /api/cards/:id/position（view='c' 桶）；回滚 = 移除本文件引用。
 * ===================================================================== */
(() => {
    if (localStorage.getItem('nodeCanvas_disabled') === '1') return;

    const API = {
        graph: '/api/cards/graph',
        types: '/api/card-types',
        cards: '/api/cards',
        scan: '/api/scan-agents',
    };

    class NodeCanvas {
        constructor() {
            this.nodes = new Map();   // id → {id,kind,title,body,status,x,y,el,profileMissing}
            this.edges = new Map();   // id → {id,source,target,kind,dispatch_id,status}
            this.types = new Map();   // type_key → row
            this.agents = [];         // scan-agents 清单（建智能体卡选择用）
            this.link = null;         // 连线状态机 {kind, sourceId, valid:Set}
            this.scale = 1;
            this.pan = { x: 40, y: 40 };
            this._timers = new Map();
            this._dragging = null;
            this._panning = null;
            this._dragMoved = false;
        }

        async init() {
            await this.loadTypes();
            await this.loadAgents().catch(() => {});
            this.buildUi();
            await this.reload();
            this.bindGlobal();
            this._refreshTimer = setInterval(() => {
                if (this.visible && !this._dragging && !this._panning) this.reload();
            }, 12000);
        }

        /* ── 数据装载 ─────────────────────────────── */
        async loadTypes() {
            try {
                const r = await fetch(API.types).then(x => x.json());
                (r.types || []).forEach(t => this.types.set(t.type_key, t));
            } catch { /* 失败时按内置四种兜底 */ }
            if (!this.types.size) {
                [['task', '任务', 1, 0, 0, 1], ['agent', '智能体', 0, 1, 0, 0],
                 ['handoff', '交接文档', 0, 0, 1, 0], ['doc', '文档', 0, 0, 0, 0]]
                    .forEach(([k, l, do_, di, io, ii]) =>
                        this.types.set(k, { type_key: k, label: l, builtin: 1, can_dispatch_out: do_, can_dispatch_in: di, can_inject_out: io, can_inject_in: ii }));
            }
        }
        async loadAgents() {
            try {
                const r = await fetch(API.scan).then(x => x.json());
                this.agents = r.agents || r.rows || [];
            } catch { this.agents = []; }
        }
        async reload() {
            let g;
            try { g = await fetch(API.graph).then(x => x.json()); }
            catch { return; }
            const keep = new Map();
            for (const n of (g.nodes || [])) {
                const kind = String(n.kind ?? '');
                // 辅助记忆/归档/取消不进画布（对账口径与任务地图一致）
                if (kind.startsWith('aux_') || n.status === 'archived' || n.status === 'cancelled') continue;
                const pos = n.meta?.map_pos?.c;
                keep.set(Number(n.id), {
                    id: Number(n.id), kind, title: n.title ?? '', body: n.body ?? '', status: n.status ?? '',
                    x: Number(pos?.x) || 0, y: Number(pos?.y) || 0,
                    profileMissing: !!n.profileMissing,
                });
            }
            this.nodes = keep;
            this.edges = new Map((g.edges || []).map(e => [Number(e.id), e]));
            // 派生视觉边：交接挂边（links.kind='handoff'，任务卡→交接卡）只读展示，不可删
            for (const l of (g.links || [])) {
                if (l.kind !== 'handoff') continue;
                const dup = [...this.edges.values()].some(e => e.source_id === l.src_id && e.target_id === l.dst_id);
                if (!dup) this.edges.set(`l${l.src_id}_${l.dst_id}`, { source_id: l.src_id, target_id: l.dst_id, kind: 'handoff', status: 'active', derived: true });
            }
            if (this.visible) this.renderAll();
        }
        refreshSoon() { clearTimeout(this._reloadT); this._reloadT = setTimeout(() => this.reload(), 300); }

        /* ── 界面骨架（自包含注入） ───────────────── */
        buildUi() {
            const style = document.createElement('style');
            style.textContent = `
#ncView{position:absolute;inset:0;display:none;z-index:5;overflow:hidden;
  background-color:#10151f;background-image:radial-gradient(circle, rgba(110,130,160,.12) 1px, transparent 1px);
  background-size:22px 22px}
#ncView.on{display:block}
#ncWorld{position:absolute;left:0;top:0;transform-origin:0 0}
#ncSvg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
#ncSvg path{pointer-events:auto}
.nc-node{position:absolute;width:216px;min-height:66px;background:#1b2230;border:1px solid #39465c;
  border-radius:10px;padding:8px 10px;box-sizing:border-box;cursor:grab;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.nc-node:active{cursor:grabbing}
.nc-badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:4px;background:#2c3850;
  margin-right:6px;cursor:pointer;user-select:none}
.nc-badge:hover{outline:1px solid #6aa9ff}
.nc-title{font-size:13px;color:#dbe4f0;word-break:break-all}
.nc-sub{font-size:11px;color:#7d8aa0;margin-top:3px;word-break:break-all}
.nc-port{position:absolute;bottom:-11px;font-size:11px;padding:2px 9px;border-radius:6px;
  background:#23402c;color:#9fe0b4;border:1px solid #3f7a50;cursor:crosshair;z-index:11}
.nc-port:hover{background:#2c5636}
.nc-port.out{right:6px}.nc-port.in{left:6px;background:#20304a;color:#9fc0ff;border-color:#3a5f9f}
.nc-linking .nc-target{outline:2px solid #6aa9ff;outline-offset:3px;animation:ncPulse 1.2s infinite}
@keyframes ncPulse{50%{outline-color:rgba(106,169,255,.4)}}
.nc-invalid{animation:ncShake .4s}
@keyframes ncShake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
#ncPanel{position:absolute;left:12px;top:12px;z-index:30;display:flex;flex-direction:column;gap:8px}
.nc-panel-item{background:#1e2530;border:1px solid #3a4658;border-radius:8px;padding:8px 16px;
  cursor:grab;user-select:none;font-size:13px;color:#dbe4f0}
.nc-panel-item:hover{border-color:#6aa9ff}
.nc-ghost{position:fixed;z-index:999;pointer-events:none;opacity:.75;background:rgba(106,169,255,.15);
  border:1px dashed #6aa9ff;border-radius:8px;padding:8px 16px;font-size:13px;color:#dbe4f0}
.nc-pop{position:fixed;z-index:60;background:#151b26;border:1px solid #3a4658;border-radius:10px;
  padding:12px 14px;width:262px;font-size:13px;color:#dbe4f0;box-shadow:0 6px 20px rgba(0,0,0,.5)}
.nc-pop h4{margin:0 0 8px;font-size:13px}
.nc-pop .row{margin:6px 0;display:flex;align-items:center;gap:8px}
.nc-pop label{flex:0 0 62px;font-size:12px;color:#8fa0b8}
.nc-pop input,.nc-pop select,.nc-pop textarea{flex:1;background:#0f141d;border:1px solid #3a4658;
  border-radius:6px;color:#dbe4f0;padding:4px 8px;font-size:12px;min-width:0}
.nc-pop textarea{height:64px;resize:vertical}
.nc-btns{display:flex;gap:8px;margin-top:10px}
.nc-btn{flex:1;border-radius:6px;padding:5px 0;font-size:12px;cursor:pointer;border:1px solid #3a4658;
  background:#2a2f3a;color:#aab6c8}
.nc-btn.ok{background:#23402c;color:#9fe0b4;border-color:#3f7a50}
.nc-btn.warn{background:#402424;color:#e0a0a0;border-color:#7a3f3f}
.nc-type-item{padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#dbe4f0}
.nc-type-item:hover{background:#233046}
.nc-type-item.small{color:#8fa0b8;font-size:12px;border-top:1px solid #2a3346;margin-top:4px;padding-top:8px}
#ncSvg path.edge{fill:none;stroke:#6aa9ff;stroke-width:2}
#ncSvg path.edge.inject{stroke:#d9a441;stroke-dasharray:6 4}
#ncSvg path.edge.superseded{stroke:#556;stroke-dasharray:4 4}
#ncSvg path.edge.handoff{stroke:#4a8a5c;stroke-dasharray:2 4}
#ncSvg path.edge.completed{stroke:#4a8a5c}
#ncToast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);
  background:rgba(21,27,38,.95);border:1px solid #3a4658;border-radius:8px;padding:8px 20px;
  font-size:13px;color:#dbe4f0;opacity:0;transition:.25s;z-index:999;pointer-events:none}
#ncToast.on{opacity:1;transform:translateX(-50%) translateY(0)}`;
            document.head.appendChild(style);

            this.toastEl = Object.assign(document.createElement('div'), { id: 'ncToast' });
            document.body.appendChild(this.toastEl);

            // 画布容器：挂在任务地图同层
            const mapEl = document.querySelector('#taskMap');
            const host = mapEl?.parentElement;
            if (!host) return;
            this.viewEl = Object.assign(document.createElement('div'), { id: 'ncView' });
            this.viewEl.innerHTML = `
              <div id="ncPanel"><div class="nc-panel-item" data-nc="create">＋ 卡片</div></div>
              <div id="ncWorld"><svg id="ncSvg"><defs><marker id="ncArrow" markerWidth="8" markerHeight="8"
                refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8899aa"/></marker></defs></svg>
              <div id="ncNodes"></div></div>`;
            host.appendChild(this.viewEl);
            this.worldEl = this.viewEl.querySelector('#ncWorld');
            this.svgEl = this.viewEl.querySelector('#ncSvg');
            this.nodesEl = this.viewEl.querySelector('#ncNodes');

            // 入口按钮：插进任务地图缩放按钮旁
            const zoomBtn = document.querySelector('#taskMapZoomOutBtn');
            if (zoomBtn) {
                const btn = Object.assign(document.createElement('button'), {
                    className: 'btn-ghost', textContent: '节点画布',
                    title: '在节点画布与任务地图之间切换',
                });
                btn.style.cssText = 'padding:6px 14px;font-size:12px';
                btn.onclick = () => this.toggle();
                zoomBtn.parentElement.insertBefore(btn, zoomBtn);
            }

            // 面板拖入建卡
            this.viewEl.querySelector('[data-nc="create"]').addEventListener('pointerdown', e => this.startCreate(e));
            // 画布平移 / 缩放 / 空点取消连线
            this.viewEl.addEventListener('wheel', e => {
                e.preventDefault();
                const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
                this.zoomAt(this.scale * factor);
            }, { passive: false });
            this.viewEl.addEventListener('pointerdown', e => {
                if (e.target !== this.viewEl && e.target !== this.worldEl && e.target !== this.svgEl) return;
                if (this.link) return this.exitLink();
                this._panning = { sx: e.clientX, sy: e.clientY, ox: this.pan.x, oy: this.pan.y };
                const move = ev => {
                    this.pan.x = this._panning.ox + ev.clientX - this._panning.sx;
                    this.pan.y = this._panning.oy + ev.clientY - this._panning.sy;
                    this.applyTransform();
                };
                const up = () => {
                    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
                    this._panning = null;
                };
                addEventListener('pointermove', move); addEventListener('pointerup', up);
            });
        }

        get visible() { return this.viewEl?.classList.contains('on'); }
        toggle() {
            const mapEl = document.querySelector('#taskMap');
            this.viewEl.classList.toggle('on');
            const on = this.visible;
            if (mapEl) mapEl.style.visibility = on ? 'hidden' : '';
            if (on) { this.reload(); this.applyTransform(); }
        }

        zoomAt(next) {
            this.scale = Math.min(2.5, Math.max(0.35, next));
            this.applyTransform();
        }
        applyTransform() {
            this.worldEl.style.transform = `translate(${this.pan.x}px,${this.pan.y}px) scale(${this.scale})`;
        }
        toWorld(cx, cy) {
            const r = this.viewEl.getBoundingClientRect();
            return [(cx - r.left - this.pan.x) / this.scale, (cy - r.top - this.pan.y) / this.scale];
        }

        /* ── 建卡（先建卡后选型：一律中性文档卡） ── */
        startCreate(e) {
            e.preventDefault();
            const ghost = Object.assign(document.createElement('div'), { className: 'nc-ghost', textContent: '新卡片' });
            document.body.appendChild(ghost);
            const move = ev => { ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 12 + 'px'; };
            const up = async ev => {
                removeEventListener('pointermove', move); removeEventListener('pointerup', up); ghost.remove();
                const r = this.viewEl.getBoundingClientRect();
                if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
                const [wx, wy] = this.toWorld(ev.clientX, ev.clientY);
                try {
                    const res = await fetch(API.cards, {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ title: '新卡片', kind: 'doc', meta: { map_pos: { c: { x: Math.round(wx), y: Math.round(wy) } } } }),
                    }).then(x => x.json());
                    if (res.ok) { this.toast(`已创建卡片 #${res.id}，点击类型徽标选择类型`); await this.reload(); this.editCard(Number(res.id)); }
                    else this.toast(res.error || '创建失败');
                } catch { this.toast('创建失败：服务不可达'); }
            };
            addEventListener('pointermove', move); addEventListener('pointerup', up);
        }

        /* ── 渲染 ────────────────────────────────── */
        renderAll() { this.renderNodes(); this.renderEdges(); }
        renderNodes() {
            this.nodesEl.innerHTML = '';
            // 无位置的卡自动瀑布排布，避免全部叠在原点
            let auto = 0;
            for (const n of this.nodes.values()) {
                if (!n.x && !n.y) { n.x = 40 + (auto % 4) * 250; n.y = 40 + Math.floor(auto / 4) * 110; auto++; }
                this.nodesEl.appendChild(this.nodeEl(n));
            }
        }
        nodeEl(n) {
            const el = document.createElement('div');
            el.className = 'nc-node';
            el.dataset.id = n.id;
            const t = this.types.get(n.kind);
            const badgeColor = t?.color ? `style="background:${t.color}"` : '';
            const sub = [];
            if (n.kind === 'agent') {
                sub.push(n.profileMissing ? '⚠️ 智能体载体缺失' : '');
            }
            el.innerHTML = `
              <span class="nc-badge" ${badgeColor} title="点击选择卡片类型">${t?.label ?? n.kind}</span>
              <span class="nc-title"></span>
              <div class="nc-sub">${sub.join(' ')}</div>
              ${t?.can_dispatch_out ? '<button class="nc-port out" title="发起派发连线">派发 ⟶</button>' : ''}
              ${t?.can_inject_out ? '<button class="nc-port out" title="发起前情注入连线">注入 ⟶</button>' : ''}
              ${(t?.can_dispatch_in || t?.can_inject_in) ? '<span class="nc-port in">⟵ 入</span>' : ''}`;
            el.querySelector('.nc-title').textContent = n.title;
            el.querySelector('.nc-badge').onclick = e => { e.stopPropagation(); this.typeMenu(n, e); };
            el.querySelectorAll('.nc-port.out').forEach(p => {
                p.onclick = e => {
                    e.stopPropagation();
                    this.enterLink(p.textContent.startsWith('派发') ? 'dispatch' : 'inject', n);
                };
            });
            el.addEventListener('pointerdown', e => this.startDrag(e, n));
            el.addEventListener('click', () => {
                if (this.link) this.onLinkTarget(n);
                else if (!this._dragMoved) this.editCard(n);
            });
            el.addEventListener('contextmenu', e => {
                e.preventDefault();
                this.confirmPop(e, '删除该卡片？', async () => {
                    const res = await fetch(`${API.cards}/${n.id}`, { method: 'DELETE' }).then(x => x.json()).catch(() => ({}));
                    this.toast(res.ok ? '已删除' : (res.error || '删除失败'));
                    this.refreshSoon();
                });
            });
            el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
            n.el = el;
            return el;
        }
        renderEdges() {
            this.svgEl.querySelectorAll('path.edge').forEach(p => p.remove());
            for (const e of this.edges.values()) {
                const s = this.nodes.get(Number(e.source_id)), t = this.nodes.get(Number(e.target_id));
                if (!s || !t) continue;
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const x1 = s.x + 216, y1 = s.y + 33, x2 = t.x, y2 = t.y + 33;
                const dx = Math.max(40, Math.abs(x2 - x1) / 2);
                p.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
                p.setAttribute('marker-end', 'url(#ncArrow)');
                p.setAttribute('class', `edge ${e.kind} ${e.status || 'active'}`);
                if (e.kind === 'inject' && !e.derived) {
                    p.addEventListener('contextmenu', ev => {
                        ev.preventDefault(); ev.stopPropagation();
                        this.confirmPop(ev, '删除该前情注入连线？', async () => {
                            const res = await fetch(`/api/card-edges/${e.id}`, { method: 'DELETE' }).then(x => x.json()).catch(() => ({}));
                            this.toast(res.ok ? '已删除连线' : (res.error || '删除失败'));
                            this.refreshSoon();
                        });
                    });
                }
                p.addEventListener('click', ev => ev.stopPropagation());
                this.svgEl.appendChild(p);
            }
        }

        /* ── 拖动 ────────────────────────────────── */
        startDrag(e, n) {
            if (e.target.closest('.nc-port,.nc-badge') || this.link) return;
            e.preventDefault();
            const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
            this._dragging = n; this._dragMoved = false;
            const move = ev => {
                if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) this._dragMoved = true;
                n.x = ox + (ev.clientX - sx) / this.scale;
                n.y = oy + (ev.clientY - sy) / this.scale;
                n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px';
                this.renderEdges();
            };
            const up = () => {
                removeEventListener('pointermove', move); removeEventListener('pointerup', up);
                this._dragging = null;
                if (this._dragMoved) {
                    clearTimeout(this._timers.get(n.id));
                    this._timers.set(n.id, setTimeout(() =>
                        fetch(`/api/cards/${n.id}/position`, {
                            method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ view: 'c', x: Math.round(n.x), y: Math.round(n.y) }),
                        }).catch(() => {}), 400));
                }
            };
            addEventListener('pointermove', move); addEventListener('pointerup', up);
        }

        /* ── 类型菜单 / 改型 / 自定义类型 ────────── */
        typeMenu(n, e) {
            this.closePops();
            const pop = this.pop(`left:${e.clientX}px;top:${e.clientY}px`);
            pop.innerHTML = '<h4>选择卡片类型</h4><div class="nc-type-list"></div>';
            const list = pop.querySelector('.nc-type-list');
            for (const t of this.types.values()) {
                if (t.type_key === n.kind) continue;
                const item = document.createElement('div');
                item.className = 'nc-type-item';
                item.textContent = t.label;
                item.onclick = () => { this.closePops(); this.retype(n, t); };
                list.appendChild(item);
            }
            const mk = document.createElement('div');
            mk.className = 'nc-type-item small';
            mk.textContent = '＋ 新建自定义类型…';
            mk.onclick = () => { this.closePops(); this.newTypeForm(n); };
            list.appendChild(mk);
        }
        newTypeForm(n) {
            const pop = this.pop('left:80px;top:80px;width:300px');
            pop.innerHTML = `
              <h4>新建自定义类型</h4>
              <div class="row"><label>显示名</label><input key="label" placeholder="例：里程碑"></div>
              <div class="row"><label>标识</label><input key="type_key" placeholder="例：milestone（小写字母开头）"></div>
              <div class="row"><label>颜色</label><input key="color" placeholder="#8f7a3d（可空）"></div>
              <div class="row"><label><input type="checkbox" key="can_dispatch_out"> 可发起派发</label></div>
              <div class="row"><label><input type="checkbox" key="can_dispatch_in"> 可接收派发</label></div>
              <div class="row"><label><input type="checkbox" key="can_inject_out"> 可发起注入</label></div>
              <div class="row"><label><input type="checkbox" key="can_inject_in"> 可接收注入</label></div>
              <div class="nc-btns"><button class="nc-btn ok" act="ok">创建并应用</button><button class="nc-btn" act="cancel">取消</button></div>`;
            const q = k => pop.querySelector(`[key="${k}"]`);
            pop.querySelector('[act="cancel"]').onclick = () => this.closePops();
            pop.querySelector('[act="ok"]').onclick = async () => {
                const body = { type_key: q('type_key').value.trim(), label: q('label').value.trim(), color: q('color').value.trim() };
                for (const f of ['can_dispatch_out', 'can_dispatch_in', 'can_inject_out', 'can_inject_in']) body[f] = q(f).checked ? 1 : 0;
                const r = await fetch(API.types, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({}));
                if (!r.ok) return this.toast(r.error || '创建类型失败');
                await this.loadTypes();
                this.closePops();
                this.toast(`已创建类型「${body.label}」`);
                if (n) this.retype(n, this.types.get(body.type_key));
            };
        }
        async retype(n, t) {
            if (t.type_key === 'agent' && !n.el.dataset.profileReady) {
                const prof = await this.agentForm(n);
                if (!prof) return;
                return this.doRetype(n, t, { profile: prof });
            }
            return this.doRetype(n, t);
        }
        async doRetype(n, t, extra = {}) {
            const r = await fetch(`${API.cards}/${n.id}/retype`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind: t.type_key, ...extra }),
            }).then(x => x.json()).catch(() => ({}));
            if (!r.ok) return this.toast(r.error || '改型失败');
            this.toast(`已改为「${t.label}」${t.type_key === 'agent' ? '（可在卡上继续完善配置）' : ''}`);
            this.refreshSoon();
        }
        /** 智能体配置向导：切到智能体类型时填写 */
        agentForm(n) {
            return new Promise(resolve => {
                this.closePops();
                const pop = this.pop('left:80px;top:80px;width:320px');
                const opts = this.agents.map(a => `<option value="${a.id ?? ''}">${a.name ?? a.id ?? ''}</option>`).join('');
                pop.innerHTML = `
                  <h4>智能体配置（卡片 #${n.id}）</h4>
                  <div class="row"><label>名称</label><input key="name" value=""></div>
                  <div class="row"><label>智能体</label><select key="agent_key">${opts || '<option value="">（未扫描到，可留空）</option>'}</select></div>
                  <div class="row"><label>执行通道</label><select key="channel">
                    <option value="queue">队列 · 由智能体领单（保底）</option>
                    <option value="cdp">驾驶 · 界面直驱+直播</option>
                    <option value="cli">直控 · 终端流（满血）</option></select></div>
                  <div class="row"><label>工作区</label><input key="workspace" placeholder="D:\\项目\\目录（可空）"></div>
                  <div class="row"><label>模型</label><input key="model" placeholder="模型名（可空）"></div>
                  <div class="row"><label>推理强度</label><input key="reasoning" placeholder="如 standard（可空）"></div>
                  <div class="row"><label>上下文</label><input key="context_tokens" placeholder="如 128000（可空）"></div>
                  <div class="nc-btns"><button class="nc-btn ok" act="ok">确定</button><button class="nc-btn" act="cancel">取消</button></div>`;
                pop.querySelector('[key="name"]').value = n.title && n.title !== '新卡片' ? n.title : '智能体卡';
                const q = k => pop.querySelector(`[key="${k}"]`);
                pop.querySelector('[act="cancel"]').onclick = () => { this.closePops(); resolve(null); };
                pop.querySelector('[act="ok"]').onclick = () => {
                    const prof = {
                        name: q('name').value.trim() || '智能体卡', agent_key: q('agent_key').value,
                        channel: q('channel').value, workspace: q('workspace').value.trim(),
                        model: q('model').value.trim(), reasoning: q('reasoning').value.trim(),
                        context_tokens: Number(q('context_tokens').value) || undefined,
                    };
                    this.closePops();
                    resolve(prof);
                };
            });
        }

        /* ── 卡片详情编辑 ────────────────────────── */
        editCard(n) {
            this.closePops();
            const r = n.el.getBoundingClientRect();
            const left = Math.min(r.right + 8, innerWidth - 290);
            const pop = this.pop(`left:${Math.max(8, left)}px;top:${Math.max(8, r.top)}px;width:280px`);
            pop.innerHTML = `
              <h4>编辑卡片 #${n.id}</h4>
              <div class="row"><label>标题</label><input key="title" value=""></div>
              <div class="row"><label>正文</label><textarea key="body"></textarea></div>
              <div class="nc-btns"><button class="nc-btn ok" act="save">保存</button><button class="nc-btn warn" act="del">删除卡片</button></div>`;
            const q = k => pop.querySelector(`[key="${k}"]`);
            q('title').value = n.title; q('body').value = n.body ?? '';
            pop.querySelector('[act="save"]').onclick = async () => {
                const res = await fetch(`${API.cards}/${n.id}`, {
                    method: 'PUT', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ title: q('title').value.trim(), body: q('body').value }),
                }).then(x => x.json()).catch(() => ({}));
                this.toast(res.ok ? '已保存' : (res.error || '保存失败'));
                if (res.ok) { this.closePops(); this.refreshSoon(); }
            };
            pop.querySelector('[act="del"]').onclick = () =>
                this.confirmPop({ clientX: left + 140, clientY: r.top + 40 }, '删除该卡片？', async () => {
                    const res = await fetch(`${API.cards}/${n.id}`, { method: 'DELETE' }).then(x => x.json()).catch(() => ({}));
                    this.toast(res.ok ? '已删除' : (res.error || '删除失败'));
                    this.closePops(); this.refreshSoon();
                });
        }

        /* ── 连线状态机（确认式 v1） ─────────────── */
        enterLink(kind, src) {
            const flag = kind === 'dispatch' ? 'can_dispatch_in' : 'can_inject_in';
            const valid = new Set();
            for (const t of this.nodes.values())
                if (t.id !== src.id && (this.types.get(t.kind)?.[flag] || (kind === 'dispatch' && t.kind === 'agent') || (kind === 'inject' && t.kind === 'task')))
                    valid.add(t.id);
            if (!valid.size) return this.toast(kind === 'dispatch' ? '画布上没有可接收派发的卡片' : '画布上没有可接收注入的任务卡');
            this.exitLink();
            this.link = { kind, sourceId: src.id, valid };
            this.viewEl.classList.add('nc-linking');
            valid.forEach(id => this.nodes.get(id).el.classList.add('nc-target'));
            this.toast(kind === 'dispatch' ? '点击目标智能体卡完成派发（按 Esc 取消）' : '点击目标任务卡完成前情注入（按 Esc 取消）');
        }
        exitLink() {
            this.viewEl?.querySelectorAll('.nc-target').forEach(el => el.classList.remove('nc-target'));
            this.viewEl?.classList.remove('nc-linking');
            this.link = null;
        }
        onLinkTarget(n) {
            const { kind, sourceId, valid } = this.link;
            const src = this.nodes.get(sourceId);
            if (!src) return this.exitLink();
            if (!valid.has(n.id)) {
                n.el.classList.add('nc-invalid');
                setTimeout(() => n.el.classList.remove('nc-invalid'), 450);
                return this.toast(`非法连线：${this.types.get(src.kind)?.label ?? src.kind} → ${this.types.get(n.kind)?.label ?? n.kind}`);
            }
            if (kind === 'dispatch') this.dispatchConfirm(src, n);
            else this.createInject(src, n);
        }
        async dispatchConfirm(src, dst) {
            this.closePops();
            let st = {};
            try { st = await fetch(`/api/agent-cards/${dst.id}/state`).then(x => x.json()); } catch { /* 状态拿不到仍可尝试派发 */ }
            if (st.carrier_missing) { this.toast('⚠️ 该智能体载体缺失，请先在卡片配置中选择已安装的智能体'); return this.exitLink(); }
            const r = dst.el.getBoundingClientRect();
            const pop = this.pop(`left:${Math.min(r.right + 8, innerWidth - 280)}px;top:${Math.max(8, r.top)}px;width:270px`);
            const chLabel = { cli: '直控 · 终端流', cdp: '驾驶 · 界面直播', queue: '队列 · 领单' }[st.channel] ?? '队列 · 领单';
            pop.innerHTML = `
              <h4>派发确认</h4>
              <div class="row">任务：${src.title}</div>
              <div class="row">智能体：${st.name ?? dst.title} · ${chLabel}</div>
              <div class="row">${st.queue_depth ? `队列中已有 ${st.queue_depth} 项（将排队执行）` : '当前空闲，立即执行'}</div>
              <div class="nc-btns"><button class="nc-btn ok" act="ok">确认派发</button><button class="nc-btn" act="cancel">取消</button></div>`;
            pop.querySelector('[act="cancel"]').onclick = () => { this.closePops(); this.exitLink(); };
            pop.querySelector('[act="ok"]').onclick = async () => {
                this.closePops();
                const res = await fetch(`/api/cards/${src.id}/dispatch-agent`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ agent_card_id: dst.id }),
                }).then(x => x.json().catch(() => ({})));
                if (res.ok) {
                    if (res.edgeId) this.edges.set(Number(res.edgeId), { id: Number(res.edgeId), source_id: src.id, target_id: dst.id, kind: 'dispatch', dispatch_id: res.dispatch?.id ?? null, status: 'active' });
                    this.renderEdges();
                    this.toast(`已派发${res.dispatch ? `（第 ${res.dispatch.generation + 1} 次尝试）` : ''}`);
                } else this.toast(res.error || '派发失败');
                this.exitLink();
            };
        }
        async createInject(src, dst) {
            this.closePops();
            const res = await fetch('/api/card-edges', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source_id: src.id, target_id: dst.id, kind: 'inject' }),
            }).then(x => x.json()).catch(() => ({}));
            if (res.ok) { this.edges.set(Number(res.id), { id: Number(res.id), source_id: src.id, target_id: dst.id, kind: 'inject', status: 'active' }); this.renderEdges(); this.toast('已建立前情注入：派发时将注入该交接摘要'); }
            else this.toast(res.error || '注入连线失败');
            this.exitLink();
        }

        /* ── 通用弹层 / 提示 ─────────────────────── */
        pop(posCss) {
            const el = document.createElement('div');
            el.className = 'nc-pop';
            el.style.cssText = posCss;
            document.body.appendChild(el);
            this._pops = this._pops || [];
            this._pops.push(el);
            return el;
        }
        closePops() { (this._pops || []).forEach(p => p.remove()); this._pops = []; }
        confirmPop(e, text, onOk) {
            this.closePops();
            const pop = this.pop(`left:${Math.min(e.clientX, innerWidth - 220)}px;top:${Math.min(e.clientY, innerHeight - 120)}px;width:200px`);
            pop.innerHTML = `<h4>${text}</h4><div class="nc-btns"><button class="nc-btn warn" act="ok">删除</button><button class="nc-btn" act="cancel">取消</button></div>`;
            pop.querySelector('[act="cancel"]').onclick = () => this.closePops();
            pop.querySelector('[act="ok"]').onclick = () => { this.closePops(); onOk(); };
        }
        toast(msg) {
            this.toastEl.textContent = msg;
            this.toastEl.classList.add('on');
            clearTimeout(this._toastT);
            this._toastT = setTimeout(() => this.toastEl.classList.remove('on'), 2400);
        }
        bindGlobal() {
            addEventListener('keydown', e => { if (e.key === 'Escape' && this.link) this.exitLink(); });
        }
    }

    // 双保险：脚本执行时 DOM 已就绪（缓存/恢复加载场景）则直接初始化，否则等 DOMContentLoaded
    const boot = () => {
        try {
            window.__nodeCanvas = new NodeCanvas();
            window.__nodeCanvas.init();
        } catch (e) { console.error('节点画布初始化失败', e); }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
