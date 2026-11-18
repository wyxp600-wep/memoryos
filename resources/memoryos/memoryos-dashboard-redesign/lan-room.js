(() => {
  'use strict';
  const root = document.getElementById('lanRooms');
  if (!root) return;
  const guest = document.body.classList.contains('lan-guest');
  const desktop = window.memoryosDesktop;
  const inSharedView = () => location.hash === '#tasks/shared';
  const directoryTitle = guest ? '共享任务' : '局域网房间';
  const guestRoom = guest ? location.pathname.split('/').pop() : '';
  const guestDirectory = guest && !guestRoom;
  const tokenKey = 'memoryos.room.' + guestRoom;
  const inviteParam = () => new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  const find = selector => root.querySelector(selector);
  let guestToken = '';
  if (guest) {
    try { guestToken = localStorage.getItem(tokenKey) || ''; } catch { /* 会话仍可在当前页面使用 */ }
  }

  root.innerHTML = `
    <header class="lan-header">
      <div>
        ${guest ? '<h1 id="lanTitle">共享任务</h1>' : '<h2 id="lanTitle" class="lan-title">局域网房间</h2>'}
        <p class="lan-muted" id="lanSubtitle">与同一局域网的成员协作。</p>
      </div>
      <div class="lan-actions" id="lanHeaderActions">
        <button type="button" data-act="home" hidden>返回房间列表</button>
        <button type="button" data-act="compose" class="lan-primary" hidden>发布任务</button>
        <button type="button" data-act="import" hidden>从个人看板分享</button>
      </div>
    </header>
    <p class="lan-error" id="lanError" role="alert"></p>
    <div id="lanSharePrompt" class="lan-note lan-share-prompt" hidden>
      <p role="status"></p>
      <button type="button" data-act="cancelShare">取消分享</button>
    </div>
    <section id="lanLocalServer" class="lan-panel" aria-labelledby="lanServerHeading" hidden>
      <div class="lan-server-head">
        <div>
          <h2 id="lanServerHeading">本机服务器</h2>
          <p id="lanServerHint" class="lan-muted">使用与同伴相同的 Wi-Fi 或有线网络。</p>
        </div>
        <span id="lanServerStatus" class="lan-status" role="status"></span>
      </div>
      <form id="lanServerForm" class="lan-server-start lan-section" hidden>
        <label for="lanServerNetwork">服务器网卡</label>
        <select id="lanServerNetwork" required></select>
        <button type="submit" class="lan-primary" disabled>启动本机服务器</button>
      </form>
      <div id="lanServers"></div>
      <div class="lan-actions lan-section">
        <button type="button" data-act="stopServer" hidden>停止本机服务器</button>
      </div>
    </section>
    <section id="lanHome" hidden>
      <div class="lan-home-grid">
        <div class="lan-panel">
          <h2>我的房间</h2>
          <div id="lanOwned" class="lan-section"></div>
          <h3 class="lan-section">已加入</h3>
          <div id="lanJoined" class="lan-section"></div>
          <div class="lan-actions lan-section">
            <button type="button" data-act="create" class="lan-primary">创建房间</button>
            <button type="button" data-act="link">通过地址加入</button>
          </div>
        </div>
        <div class="lan-panel">
          <h2>附近的房间</h2>
          <p class="lan-muted">搜索同一局域网内正在共享的房间。</p>
          <div id="lanDiscovered" class="lan-section" aria-live="polite"></div>
          <button type="button" data-act="discover">发现房间</button>
        </div>
      </div>
    </section>
    <section id="lanDirectory" class="lan-panel" hidden>
      <h2>可加入的房间</h2>
      <div id="lanDirectoryList" class="lan-section"></div>
    </section>
    <section id="lanFormPanel" class="lan-panel" hidden>
      <form id="lanForm" class="lan-form">
        <h2 id="lanFormTitle"></h2>
        <p id="lanFormNote" class="lan-note" hidden></p>
        <div id="lanFields" class="lan-form"></div>
        <div class="lan-actions">
          <button type="submit" class="lan-primary"></button>
          <button type="button" data-act="cancel">取消</button>
        </div>
      </form>
    </section>
    <section id="lanRoom" hidden>
      <div class="lan-room-tools">
        <span id="lanStatus" class="lan-status" role="status"></span>
        <button type="button" data-act="refresh">刷新</button>
        <button type="button" data-act="showInvite" hidden>邀请成员</button>
        <button type="button" data-act="pause" hidden>暂停共享</button>
      </div>
      <section id="lanInvite" class="lan-panel lan-form" hidden>
        <label>本机服务器地址<input readonly id="lanServerUrl"></label>
        <label>邀请链接<input readonly id="lanInviteUrl"></label>
        <label>邀请码<input readonly id="lanInviteCode"></label>
        <div class="lan-actions">
          <button type="button" data-act="copyServer">复制服务器地址</button>
          <button type="button" data-act="copyLink">复制邀请链接</button>
          <button type="button" data-act="copyCode">复制邀请码</button>
          <button type="button" data-act="askRotate">更新邀请码</button>
          <button type="button" data-act="hideInvite">收起</button>
        </div>
        <p id="lanCopyStatus" role="status"></p>
      </section>
      <div id="lanBoard" class="lan-board"></div>
      <details class="lan-members lan-panel">
        <summary id="lanMemberCount">成员</summary>
        <ul id="lanMembers"></ul>
      </details>
    </section>`;

  function styleButton(node) {
    if (!guest) node.classList.add(node.classList.contains('lan-primary') ? 'btn-primary' : 'btn-ghost');
  }

  if (!guest) {
    root.querySelectorAll('.lan-panel').forEach(panel => panel.classList.add('glass-card'));
    root.querySelectorAll('button').forEach(styleButton);
  }

  const title = find('#lanTitle');
  const subtitle = find('#lanSubtitle');
  const errorLine = find('#lanError');
  const statusLine = find('#lanStatus');
  const form = find('#lanForm');
  const fields = find('#lanFields');
  const formPanel = find('#lanFormPanel');
  const home = find('#lanHome');
  const serverForm = find('#lanServerForm');
  const serverNetwork = find('#lanServerNetwork');
  const serverStart = serverForm.querySelector('button');
  const roomPanel = find('#lanRoom');
  const button = action => find('[data-act="' + action + '"]');
  const errorText = message => { errorLine.textContent = message; };
  let context = null;
  let state = null;
  let homeState = null;
  let submit = null;
  let busy = false;
  let pollBusy = false;
  let viewRevision = 0;
  let viewSignature = '';
  let previousFocus = null;
  let pendingCard = null;
  let roomPickerRequested = false;

  function setPendingCard(card) {
    pendingCard = card;
    const prompt = find('#lanSharePrompt');
    prompt.querySelector('p').textContent = card ? '选择一个房间，预览并发布这张任务。' : '';
    prompt.hidden = !card;
  }

  function openRequestedRoomPicker() {
    if (!roomPickerRequested || busy || !inSharedView()) return;
    roomPickerRequested = false;
    return withBusy(showHome);
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function actionButton(label, handler, key) {
    const node = el('button', label);
    node.type = 'button';
    styleButton(node);
    if (key) node.dataset.lanKey = key;
    node.addEventListener('click', () => withBusy(handler));
    return node;
  }

  function friendly(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async function request(op, data = {}) {
    if (!guest) {
      if (!desktop) throw Error('在 MemoryOS 桌面版中可使用局域网共享。');
      const result = await desktop.action({ action: 'lan-rooms', op, ...data });
      if (!result.ok) throw friendly(result.status, result.error);
      return result.value;
    }
    let response;
    try {
      response = await fetch('/api/r/' + guestRoom + '/' + op, {
        method: op === 'state' ? 'GET' : 'POST',
        headers: {
          ...(op === 'state' ? {} : { 'content-type': 'application/json' }),
          ...(guestToken ? { authorization: 'Bearer ' + guestToken } : {}),
        },
        body: op === 'state' ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(4500),
      });
    } catch { throw friendly(503, '房主暂时离线，恢复共享后可以刷新。'); }
    const value = await response.json();
    if (!response.ok) throw friendly(response.status, value.error);
    return value;
  }

  async function withBusy(run) {
    if (busy) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    errorText('');
    const submitButton = form.querySelector('[type=submit]');
    submitButton.disabled = true;
    try { await run(); }
    catch (error) { errorText(error.message); }
    finally {
      submitButton.disabled = false;
      root.removeAttribute('aria-busy');
      busy = false;
      openRequestedRoomPicker();
    }
  }

  function closeForm(restoreFocus = true) {
    formPanel.hidden = true;
    submit = null;
    if (restoreFocus && previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus();
    previousFocus = null;
  }

  function showForm(heading, note, label, handler) {
    if (formPanel.hidden) previousFocus = document.activeElement;
    fields.replaceChildren();
    find('#lanFormTitle').textContent = heading;
    const noteNode = find('#lanFormNote');
    noteNode.hidden = !note;
    noteNode.textContent = note || '';
    form.querySelector('[type=submit]').textContent = label;
    button('cancel').hidden = guest && !context;
    formPanel.hidden = false;
    submit = handler;
    return fields;
  }

  function field(label, type, options = {}) {
    const wrapper = el('label', label);
    const node = el(type === 'textarea' || type === 'select' ? type : 'input');
    if (node.tagName === 'INPUT') node.type = type;
    for (const [property, value] of Object.entries(options)) node[property] = value;
    wrapper.append(node);
    fields.append(wrapper);
    return node;
  }

  function choices(node, items, value, name) {
    for (const item of items) node.append(new Option(name(item), value(item)));
  }

  function listRow(list, name, note, label, handler) {
    const row = el('div', undefined, 'lan-row');
    const copy = el('div');
    copy.append(el('strong', name), el('div', note, 'lan-muted'));
    row.append(copy, actionButton(label, handler));
    list.append(row);
  }

  function homeView() {
    viewRevision++;
    context = state = null;
    viewSignature = '';
    statusLine.textContent = '';
    title.textContent = directoryTitle;
    subtitle.textContent = '与同一局域网的成员协作。';
    home.hidden = false;
    find('#lanLocalServer').hidden = !desktop;
    find('#lanDirectory').hidden = true;
    roomPanel.hidden = true;
    closeForm(false);
    for (const act of ['home', 'compose', 'import']) button(act).hidden = true;
  }

  async function showHome() {
    homeView();
    if (!desktop) {
      find('#lanOwned').textContent = '在 MemoryOS 桌面版创建或加入房间。';
      find('#lanJoined').textContent = '已加入的房间会显示在这里。';
      find('#lanDiscovered').textContent = '连接到局域网后，可在桌面版搜索。';
      for (const act of ['create', 'link', 'discover']) button(act).disabled = true;
      return;
    }
    for (const act of ['create', 'link', 'discover']) button(act).disabled = true;
    try {
      homeState = await request('home');
      renderServer();
      const owned = find('#lanOwned');
      const joined = find('#lanJoined');
      owned.replaceChildren();
      joined.replaceChildren();
      if (!homeState.hosted.length) owned.textContent = '还没有房间。';
      if (!homeState.joined.length) joined.textContent = '还没有加入房间。';
      for (const item of homeState.hosted) listRow(owned, item.name, item.online ? '共享中' : '已暂停',
        item.online ? '进入房间' : '恢复共享', () => item.online ? openRoom({ id: item.id, owner: true }) : hostForm(item));
      for (const item of homeState.joined) listRow(joined, item.name, item.origin, '进入房间',
        () => openRoom({ id: item.room, owner: false, name: item.name }));
    } finally {
      for (const act of ['create', 'link', 'discover']) button(act).disabled = false;
    }
  }

  function hostNetworks() {
    const regularNetwork = name => /^(wlan|wi-fi|wireless|ethernet|以太网|无线)/i.test(name);
    return [...(homeState?.adapters || [])].sort((a, b) => regularNetwork(b.name) - regularNetwork(a.name));
  }

  function networkChoices(select, networks) {
    select.replaceChildren();
    if (!networks.length) select.append(new Option('没有可用的局域网网卡', ''));
    choices(select, networks, item => item.address, item => item.name + ' · ' + item.address);
  }

  function renderServer() {
    const { servers, preferredServerAdapter, hosted } = homeState;
    const running = servers.length > 0;
    const status = find('#lanServerStatus');
    status.textContent = running ? '运行中' : '未启动';
    status.dataset.connected = String(running);
    find('#lanServerHint').textContent = running
      ? hosted.some(room => room.online) ? '同伴可用服务器地址查看在线房间。' : '服务器已就绪。创建或恢复房间后，同伴就能加入。'
      : '使用与同伴相同的 Wi-Fi 或有线网络。';
    serverForm.hidden = running;
    button('stopServer').hidden = !running;
    const networks = hostNetworks();
    networkChoices(serverNetwork, networks);
    const preferred = networks.find(item => item.name === preferredServerAdapter);
    if (preferred) serverNetwork.value = preferred.address;
    serverNetwork.disabled = !serverNetwork.value;
    serverStart.disabled = !serverNetwork.value;

    find('#lanServers').replaceChildren(...servers.map(server => {
      const row = el('div', undefined, 'lan-row');
      const address = el('input');
      address.value = server.url;
      address.readOnly = true;
      address.setAttribute('aria-label', server.name + '服务器地址');
      const copyStatus = el('span', '', 'lan-muted');
      copyStatus.setAttribute('role', 'status');
      row.append(el('strong', server.name), address,
        actionButton('复制服务器地址', () => copyInput(address, copyStatus)), copyStatus);
      return row;
    }));
  }

  function hostForm(existing) {
    const adapters = hostNetworks();
    showForm(existing ? '恢复共享' : '创建房间',
      '房间使用局域网 HTTP。请选用可信的网络。退出 MemoryOS 后，房间会暂时离线。',
      existing ? '恢复共享' : '创建并共享', async () => {
        const value = await request(existing ? 'resume' : 'create', {
          room: existing?.id, address: network.value, name: name?.value, nickname: nick?.value,
        });
        await openRoom({ id: value.id, owner: true, name: value.name });
      });
    const name = existing ? null : field('房间名', 'text', { required: true, maxLength: 60 });
    const nick = existing ? null : field('你的昵称', 'text', { required: true, maxLength: 32 });
    const network = field('局域网网卡', 'select', { required: true });
    networkChoices(network, adapters);
    const saved = adapters.find(adapter => adapter.address === existing?.address)
      || adapters.find(adapter => adapter.name === existing?.adapter)
      || adapters.find(adapter => adapter.address === homeState?.servers[0]?.address);
    if (saved) network.value = saved.address;
    (name || network).focus();
  }

  function addressForm() {
    showForm('通过地址加入', '输入房主发来的服务器地址或邀请链接。', '继续', async () => {
      const result = await request('directory', { url: address.value.trim() });
      if (result.link) return joinForm({ url: result.link, name: '', direct: true });
      showForm('选择房间', '选择房间后输入邀请码。', '继续', () => {
        const entry = result.rooms[Number(selected.value)];
        if (entry) joinForm(entry);
      });
      const selected = field('房间', 'select', { required: true });
      if (!result.rooms.length) selected.append(new Option('服务器暂无在线房间', ''));
      choices(selected, result.rooms.map((item, index) => ({ ...item, index })), item => item.index, item => item.name);
      selected.focus();
    });
    const address = field('服务器地址或邀请链接', 'url', { required: true, placeholder: 'http://192.168.1.10:29418' });
    address.focus();
  }

  function joinForm(found) {
    const heading = guest ? '加入共享任务' : found.name ? '加入「' + found.name + '」' : '通过邀请链接加入';
    showForm(heading, guest ? '使用房主分享的邀请链接或邀请码加入。' : '', '加入房间', async () => {
      const value = await request('join', {
        url: found?.url, code: code?.value, nickname: nick.value,
        invitation: guest ? code?.value : undefined,
      });
      if (guest) {
        guestToken = value.token;
        try { localStorage.setItem(tokenKey, guestToken); } catch { /* 当前会话可继续 */ }
        history.replaceState(null, '', location.pathname);
        await openRoom({ id: guestRoom, owner: false }, value.state);
      } else {
        await openRoom({ id: value.id, owner: false }, value);
      }
    });
    const nick = field('你的昵称', 'text', { required: true, maxLength: 32, autocomplete: 'nickname' });
    const code = guest || !new URL(found.url).hash
      ? field('邀请码', 'text', { required: true, maxLength: 32, value: guest ? inviteParam() : '', autocomplete: 'off', spellcheck: false })
      : null;
    if (guest && code) code.dataset.guestInvite = '';
    nick.focus();
  }

  async function browserDirectory() {
    const panel = find('#lanDirectory');
    const list = find('#lanDirectoryList');
    panel.hidden = false;
    subtitle.textContent = '选择房间并输入房主提供的邀请码';
    const response = await fetch('/api/rooms', { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error('暂时无法读取房间列表');
    const entries = await response.json();
    list.replaceChildren();
    for (const item of entries) {
      const row = el('div', undefined, 'lan-row');
      const link = el('a', '加入「' + item.name + '」');
      link.href = '/r/' + item.id;
      row.append(link);
      list.append(row);
    }
    if (!entries.length) list.textContent = '暂无在线房间。';
  }

  function roomView() {
    home.hidden = true;
    find('#lanLocalServer').hidden = true;
    roomPanel.hidden = false;
    find('#lanInvite').hidden = true;
    find('#lanBoard').replaceChildren();
    find('#lanMembers').replaceChildren();
    find('#lanMemberCount').textContent = '成员';
    closeForm(false);
    button('home').hidden = guest;
    title.textContent = context.name || '共享任务';
    subtitle.textContent = '';
    updateAvailability(false, '正在连接房间…');
  }

  async function openRoom(target, initialState) {
    viewRevision++;
    viewSignature = '';
    context = target;
    state = null;
    roomView();
    if (initialState) renderState(initialState);
    else await refresh(true);
    if (!guest && inSharedView() && state && pendingCard && !roomPickerRequested) {
      const id = pendingCard;
      setPendingCard(null);
      const card = await request('cards', { card: id });
      if (inSharedView() && !roomPickerRequested) publication(card.title, card.body, true);
    }
  }

  function updateAvailability(connected, message) {
    const value = message || (connected ? '已连接' : '房主离线');
    if (statusLine.textContent !== value) statusLine.textContent = value;
    statusLine.dataset.connected = String(connected);
    button('compose').hidden = !state;
    button('compose').disabled = !connected;
    button('import').hidden = guest || !state;
    button('import').disabled = !connected;
    button('pause').hidden = !context?.owner || !connected;
    button('showInvite').hidden = !context?.owner || !connected;
    for (const node of find('#lanBoard').querySelectorAll('button')) node.disabled = !connected;
  }

  function taskCard(task, me, expanded) {
    const card = el('article', undefined, 'lan-task');
    card.append(el('h3', task.title), el('small',
      '发布者 ' + task.publisherName + (task.assigneeName ? ' · 领取者 ' + task.assigneeName : '')));
    if (task.body) {
      const detail = el('details');
      detail.dataset.taskDetail = task.id;
      detail.open = expanded.has(task.id);
      detail.append(el('summary', '任务说明'), el('p', task.body));
      card.append(detail);
    }
    const actions = el('div', undefined, 'lan-actions');
    const append = (label, op) => actions.append(actionButton(label, () => taskAction(op, task.id), op + '/' + task.id));
    if (task.status === 'ready') append('领取', 'claim');
    if (task.status === 'active' && task.assignee === me.id) {
      append('放回', 'release');
      append('标记完成', 'finish');
    } else if (task.status === 'active' && me.role === 'owner') append('释放任务', 'release');
    if (actions.childElementCount) card.append(actions);
    return card;
  }

  function renderState(value) {
    const signature = JSON.stringify(value);
    if (guest && location.hash) history.replaceState(null, '', location.pathname);
    state = value;
    title.textContent = value.name;
    subtitle.textContent = value.me.name + (value.me.role === 'owner' ? ' · 房主' : ' · 成员');
    if (viewSignature !== signature) {
      const board = find('#lanBoard');
      const focusKey = document.activeElement?.dataset.lanKey;
      const expanded = new Set(Array.from(board.querySelectorAll('[data-task-detail][open]'), node => node.dataset.taskDetail));
      const lanes = Object.fromEntries([
        ['ready', '待领取'], ['active', '进行中'], ['done', '已完成'],
      ].map(([key, label]) => [key, { label, tasks: [] }]));
      for (const task of value.tasks) if (Object.hasOwn(lanes, task.status)) lanes[task.status].tasks.push(task);
      board.replaceChildren(...Object.values(lanes).map(({ label, tasks }) => {
        const lane = el('section', undefined, guest ? 'lan-lane' : 'lan-lane glass-card');
        const heading = el('h3', label);
        heading.append(el('span', String(tasks.length), 'lan-muted'));
        lane.append(heading);
        if (!tasks.length) lane.append(el('p', '暂无任务', 'lan-empty'));
        for (const task of tasks) lane.append(taskCard(task, value.me, expanded));
        return lane;
      }));
      if (focusKey) {
        const replacement = Array.from(board.querySelectorAll('button')).find(node => node.dataset.lanKey === focusKey);
        (replacement || button('refresh')).focus();
      }
      find('#lanMemberCount').textContent = '成员（' + value.members.length + '）';
      find('#lanMembers').replaceChildren(...value.members.map(member => el('li',
        member.name + (member.role === 'owner' ? ' · 房主' : ''))));
      viewSignature = signature;
    }
    updateAvailability(true);
  }

  async function refresh(force = false) {
    if (!context || pollBusy && !force) return;
    const revision = viewRevision;
    pollBusy = true;
    try {
      const value = await request('state', { room: context.id, owner: context.owner });
      if (revision !== viewRevision || busy && !force) return;
      renderState(value);
    } catch (error) {
      if (revision !== viewRevision || busy && !force) return;
      updateAvailability(false, error.message);
      if (guest && error.status === 401) {
        guestToken = '';
        try { localStorage.removeItem(tokenKey); } catch { /* 存储不可用 */ }
        context = state = null;
        closeForm(false);
        roomPanel.hidden = true;
        joinForm();
      }
    } finally { pollBusy = false; }
  }

  async function taskAction(op, task) {
    try { renderState(await request(op, { room: context.id, owner: context.owner, task })); }
    catch (error) {
      await refresh(true);
      if (error.status === 409 && op === 'claim') {
        const effective = state?.tasks.find(item => item.id === task);
        if (effective?.assigneeName) throw Error('任务已由「' + effective.assigneeName + '」领取。');
      }
      throw error;
    }
  }

  function publication(titleValue = '', bodyValue = '', fromBoard = false) {
    let lastPayload = '';
    let requestId = '';
    showForm(fromBoard ? '确认分享内容' : '发布任务',
      fromBoard ? '将以下标题和说明发布到「' + state.name + '」。请先检查内容。' : '',
      '发布到房间', async () => {
        if (heading.value.length > 160 || body.value.length > 12000) throw Error('请将标题缩短至 160 字符、说明缩短至 12000 字符以内。');
        const payload = JSON.stringify([heading.value, body.value]);
        if (payload !== lastPayload) {
          lastPayload = payload;
          requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
        }
        try {
          renderState(await request('publish', {
            room: context.id, owner: context.owner, title: heading.value, body: body.value, request: requestId,
          }));
          closeForm();
        } catch (error) { await refresh(true); throw error; }
      });
    const heading = field('标题', 'text', { required: true, maxLength: 160, value: titleValue });
    const body = field('说明', 'textarea', { maxLength: 12000, value: bodyValue });
    heading.focus();
  }

  function importForm() {
    let offset = 0;
    const pageSize = 80;
    showForm('从个人看板分享', '选好任务后，先预览将发送的内容。', '预览任务', async () => {
      const card = await request('cards', { card: Number(selected.value) });
      publication(card.title, card.body, true);
    });
    const selected = field('个人任务', 'select', { required: true });
    const pager = el('div', undefined, 'lan-actions');
    const previous = actionButton('上一页', () => load(Math.max(0, offset - pageSize)));
    const next = actionButton('下一页', () => load(offset + pageSize));
    const page = el('small');
    pager.append(previous, next, page);
    fields.append(pager);
    async function load(start) {
      const result = await request('cards', { offset: start });
      offset = start;
      const count = result.cards.length;
      selected.replaceChildren(new Option(count ? '请选择任务' : '这一页没有可分享的任务', ''));
      choices(selected, result.cards, card => card.id, card => card.title);
      previous.disabled = offset === 0;
      next.disabled = !result.more;
      page.textContent = '第 ' + (1 + Math.floor(offset / pageSize)) + ' 页';
      selected.focus();
    }
    return load(0);
  }

  function copyValue(id) { return copyInput(find(id), find('#lanCopyStatus')); }

  async function copyInput(input, status) {
    try {
      if (!navigator.clipboard) throw Error();
      await navigator.clipboard.writeText(input.value);
      status.textContent = '已复制。';
    } catch {
      input.focus();
      input.select();
      status.textContent = '已选中，请使用系统快捷键复制。';
    }
  }

  async function showInvite(rotate = false) {
    const result = await request(rotate ? 'rotate' : 'invite', { room: context.id });
    find('#lanInvite').hidden = false;
    find('#lanServerUrl').value = new URL(result.url).origin;
    find('#lanInviteUrl').value = result.url;
    find('#lanInviteCode').value = result.code;
    find('#lanCopyStatus').textContent = rotate ? '邀请码已更新。' : '';
  }

  const actions = {
    home: showHome,
    async stopServer() {
      const stop = async () => {
        await request('server-stop');
        await showHome();
        if (inSharedView()) serverStart.focus();
      };
      if (!homeState.hosted.some(room => room.online)) return stop();
      showForm('停止本机服务器', '在线房间会暂停共享。房间、成员和任务进度会保留。', '确认停止', stop);
      form.querySelector('[type=submit]').focus();
    },
    create: () => hostForm(null),
    link: addressForm,
    cancel: () => closeForm(),
    cancelShare() {
      setPendingCard(null);
      roomPickerRequested = false;
      (context ? button('home') : button('create')).focus();
    },
    async discover() {
      const node = find('#lanDiscovered');
      node.textContent = '正在搜索…';
      try {
        const rooms = await request('discover');
        node.replaceChildren();
        if (!rooms.length) node.textContent = '暂未发现房间。可请房主发邀请链接。';
        for (const room of rooms) listRow(node, room.name, new URL(room.url).host, '加入', () => joinForm(room));
      } catch (error) {
        node.textContent = '搜索失败，可使用邀请链接。';
        throw error;
      }
    },
    refresh: () => refresh(true),
    compose: () => publication(),
    import: importForm,
    showInvite: () => showInvite(),
    hideInvite: () => { find('#lanInvite').hidden = true; button('showInvite').focus(); },
    copyServer: () => copyValue('#lanServerUrl'),
    copyLink: () => copyValue('#lanInviteUrl'),
    copyCode: () => copyValue('#lanInviteCode'),
    askRotate() {
      showForm('更新邀请码', '旧邀请码和旧邀请链接会失效。已加入的成员可以继续使用。', '确认更新', async () => {
        await showInvite(true);
        closeForm();
      });
      form.querySelector('[type=submit]').focus();
    },
    pause() {
      showForm('暂停共享', '房间进度会保留。恢复共享前，其他成员无法进入房间。', '确认暂停', async () => {
        await request('pause', { room: context.id });
        await showHome();
      });
      form.querySelector('[type=submit]').focus();
    },
  };

  root.addEventListener('click', event => {
    const node = event.target.closest('button[data-act]');
    if (node && actions[node.dataset.act]) withBusy(actions[node.dataset.act]);
  });
  serverForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!serverNetwork.value) return;
    withBusy(async () => {
      serverStart.disabled = true;
      try {
        const result = await request('server-start', { address: serverNetwork.value });
        homeState = result;
        renderServer();
        if (inSharedView()) find('#lanServers button')?.focus();
      } finally {
        serverStart.disabled = !serverNetwork.value;
      }
    });
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submit) withBusy(submit);
  });
  if (guestDirectory) {
    withBusy(browserDirectory);
  } else if (guest) {
    window.addEventListener('hashchange', () => {
      const code = find('[data-guest-invite]');
      if (code && !context && inviteParam()) code.value = inviteParam();
    });
    if (guestToken) withBusy(() => openRoom({ id: guestRoom, owner: false }));
    else joinForm();
  } else {
    let sharedVisible = false;
    function onRoute() {
      const visible = inSharedView();
      if (sharedVisible === visible) return;
      sharedVisible = visible;
      if (!visible) { viewRevision++; return; }
      if (roomPickerRequested) openRequestedRoomPicker();
      else if (!context) withBusy(showHome);
      else refresh();
    }
    window.addEventListener('memoryos:share-task', event => {
      if (!desktop || !Number.isSafeInteger(event.detail) || event.detail <= 0) return;
      setPendingCard(event.detail);
      roomPickerRequested = Boolean(context || busy);
      openRequestedRoomPicker();
    });
    window.addEventListener('memoryos:shared-route', onRoute);
    window.addEventListener('hashchange', onRoute);
    onRoute();
  }
  setInterval(() => {
    if (context && !busy && !document.hidden && (guest || inSharedView())) refresh();
  }, 3000);
})();
