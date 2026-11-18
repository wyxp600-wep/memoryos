'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const dgram = require('node:dgram');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { createStore, RoomError, id } = require('./lan-rooms-store');

const PORT = 29418;
const MAX_BODY = 80000;
const discoveryProtocol = 'memoryos-rooms/1';
const memberOperations = new Set(['state', 'publish', 'claim', 'release', 'finish']);
const files = {
  '/room.js': ['lan-room.js', 'text/javascript; charset=utf-8'],
  '/room.css': ['lan-room.css', 'text/css; charset=utf-8'],
};

function ipv4(address) {
  return address.split('.').reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

function privateAddress(address) {
  if (typeof address !== 'string' || !net.isIPv4(address)) return false;
  const value = ipv4(address);
  return value >>> 24 === 10 || value >>> 20 === 0xac1 || value >>> 16 === 0xc0a8;
}

function adapters() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    entries.filter(item => !item.internal && item.family === 'IPv4' && privateAddress(item.address))
      .map(item => ({ name, address: item.address, netmask: item.netmask }))
  );
}

function sameSubnet(adapter, address) {
  return privateAddress(address) &&
    (ipv4(adapter.address) & ipv4(adapter.netmask)) === (ipv4(address) & ipv4(adapter.netmask));
}

function broadcast(adapter) {
  const value = ipv4(adapter.address) | ~ipv4(adapter.netmask);
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

function parseLink(value, allowDirectory = false) {
  let url;
  try { url = new URL(value); }
  catch { throw new RoomError(400, '请输入有效的房间邀请链接'); }
  const room = url.pathname.match(/^\/r\/([a-f0-9-]{36})$/)?.[1];
  const invitation = new URLSearchParams(url.hash.slice(1)).get('invite') || '';
  if (url.protocol !== 'http:' || url.port !== String(PORT) || url.username || url.password ||
      url.search || (!room && !(allowDirectory && url.pathname === '/' && !url.hash)) || !privateAddress(url.hostname) || !adapters().some(a => sameSubnet(a, url.hostname))) {
    throw new RoomError(400, '邀请链接必须指向当前局域网中的房主地址');
  }
  return { origin: url.origin, room, invitation };
}

function reply(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function readJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new RoomError(415, '请求格式不正确');
  }
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RoomError(413, '内容过长');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RoomError(413, '内容过长');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch { throw new RoomError(400, '请求格式不正确'); }
}

function listenUDP(socket, port, address) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  });
}

function decodePacket(buffer) {
  if (buffer.length > 1200) return null;
  try {
    const result = JSON.parse(buffer);
    return result?.protocol === discoveryProtocol ? result : null;
  } catch { return null; }
}

function packet(data) {
  return Buffer.from(JSON.stringify({ protocol: discoveryProtocol, ...data }));
}

async function discover() {
  const matches = new Map();
  const nonce = randomBytes(12).toString('hex');
  await Promise.all(adapters().map(async adapter => {
    const socket = dgram.createSocket('udp4');
    try {
      await listenUDP(socket, 0, adapter.address);
      socket.on('error', () => {}); // 另一张网卡仍可返回发现结果
      socket.setBroadcast(true);
      socket.on('message', (message, peer) => {
        const data = decodePacket(message);
        if (data?.nonce !== nonce || data.kind !== 'room' || peer.port !== PORT ||
            !sameSubnet(adapter, peer.address) || !id.test(data.id) ||
            typeof data.name !== 'string' || data.name.length > 60) return;
        if (!sameSubnet(adapter, data.address)) return;
        const url = 'http://' + data.address + ':' + PORT + '/r/' + data.id;
        matches.set(url, { id: data.id, name: data.name, url });
      });
      const query = packet({ kind: 'discover', nonce });
      for (const host of new Set([broadcast(adapter), adapter.address])) {
        socket.send(query, PORT, host, () => {});
      }
      await new Promise(resolve => setTimeout(resolve, 1350));
    } catch {
      // 网卡在扫描期间消失时保留其他网卡的结果。
    } finally { try { socket.close(); } catch { /* 尚未绑定 */ } }
  }));
  return Array.from(matches.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function createRoomService({ filename, uiDir, listCards, log = () => {} }) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const store = createStore(filename);
  // 房间和手动启动共用网卡监听。手动启动后，最后一个房间暂停时服务仍在线。
  const listeners = new Map();
  const online = new Map();
  const failures = new Map();
  let manualAddress;
  let receiver;
  let closing = false;
  let queue = Promise.resolve();

  function info(row) {
    const address = online.get(row.id);
    const url = address ? 'http://' + address + ':' + PORT + '/r/' + row.id : '';
    return { id: row.id, name: row.name, address: row.address, adapter: row.adapter, online: Boolean(url), server: url ? new URL(url).origin : '' };
  }

  function invite(roomId) {
    const room = store.room(roomId);
    const address = online.get(roomId);
    if (!address) throw new RoomError(409, '请先恢复共享');
    return { code: room.invite, url: 'http://' + address + ':' + PORT + '/r/' + roomId + '#invite=' + room.invite };
  }

  function rateLimit(roomId, remote, consume = false) {
    const stamp = Date.now();
    for (const [key, value] of failures) if (value.until < stamp) failures.delete(key);
    const key = roomId + '/' + remote;
    const record = failures.get(key) || { count: 0, until: stamp + 60000 };
    if (record.count >= 20) throw new RoomError(429, '尝试次数过多，请稍后再试');
    if (consume) {
      record.count++;
      failures.set(key, record);
    }
  }

  async function handle(adapter, req, res) {
    try {
      const origin = 'http://' + adapter.address + ':' + PORT;
      if (!sameSubnet(adapter, req.socket.remoteAddress) || req.headers.host !== adapter.address + ':' + PORT ||
          (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site' && req.method !== 'GET') {
        throw new RoomError(403, '仅接受当前局域网的房间请求');
      }
      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.search) throw new RoomError(404, '页面不存在');
      if (req.method === 'GET' && Object.hasOwn(files, url.pathname)) {
        const [name, type] = files[url.pathname];
        return reply(res, 200, fs.readFileSync(path.join(uiDir, name)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/rooms') {
        const active = store.rooms().filter(room => online.get(room.id) === adapter.address);
        return reply(res, 200, active.map(({ id, name }) => ({ id, name })));
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return reply(res, 200, fs.readFileSync(path.join(uiDir, 'lan-room.html')), 'text/html; charset=utf-8');
      }
      const match = url.pathname.match(/^\/(r|api\/r)\/([a-f0-9-]{36})(?:\/([a-z]+))?$/);
      if (!match || online.get(match[2]) !== adapter.address) throw new RoomError(404, '房间已离线或地址已变更');
      const [, kind, roomId, operation] = match;
      if (kind === 'r' && !operation && req.method === 'GET') {
        return reply(res, 200, fs.readFileSync(path.join(uiDir, 'lan-room.html')), 'text/html; charset=utf-8');
      }
      if (kind !== 'api/r' || req.method !== (operation === 'state' ? 'GET' : 'POST')) {
        throw new RoomError(404, '操作不存在');
      }
      const payload = req.method === 'POST' ? await readJSON(req) : {};
      if (online.get(roomId) !== adapter.address) throw new RoomError(404, '房间已离线或地址已变更');
      if (operation === 'join') {
        rateLimit(roomId, req.socket.remoteAddress);
        let token;
        try { token = store.join(roomId, payload.invitation, payload.nickname); }
        catch (error) {
          if (error.status === 403) rateLimit(roomId, req.socket.remoteAddress, true);
          throw error;
        }
        const actor = store.authorize(roomId, token, false);
        return reply(res, 200, { token, state: store.operate(roomId, actor, 'state', {}) });
      }
      if (!memberOperations.has(operation)) throw new RoomError(404, '操作不存在');
      const token = req.headers.authorization?.match(/^Bearer ([\w-]{32})$/)?.[1];
      const actor = store.authorize(roomId, token, false);
      return reply(res, 200, store.operate(roomId, actor, operation, payload));
    } catch (error) {
      if (!error.status) log('共享房间请求失败', error.code || error.name);
      if (!res.destroyed && !res.headersSent) reply(res, error.status || 500, { error: error.status ? error.message : '房间服务暂时无法处理请求' });
    }
  }

  async function startAdapter(adapter) {
    if (listeners.has(adapter.address)) return;
    const tcp = http.createServer({ requestTimeout: 8000, headersTimeout: 4000 }, (req, res) => handle(adapter, req, res));
    try {
      await new Promise((resolve, reject) => {
        tcp.once('error', reject).listen(PORT, adapter.address, resolve);
      });
      if (!receiver) await startDiscovery();
      if (closing) throw new RoomError(409, '应用正在退出');
      listeners.set(adapter.address, { tcp, adapter });
    } catch (error) {
      tcp.close();
      throw new RoomError(409, '无法开启共享。请检查所选网卡和端口 29418 是否可用。');
    }
  }

  async function startDiscovery() {
    const udp = dgram.createSocket('udp4');
    try {
      // 通配绑定接收子网广播，响应只包含与请求源同网段的房间。
      await listenUDP(udp, PORT, '0.0.0.0');
      if (closing) throw new RoomError(409, '应用正在退出');
      udp.on('error', error => log('共享房间发现失败', error.code || error.name));
      udp.on('message', (message, peer) => {
        const query = decodePacket(message);
        if (query?.kind !== 'discover' || !/^[a-f0-9]{24}$/.test(query.nonce)) return;
        for (const [roomId, address] of online) {
          const listener = listeners.get(address);
          if (!listener || !sameSubnet(listener.adapter, peer.address)) continue;
          const { name } = store.room(roomId);
          udp.send(packet({ kind: 'room', nonce: query.nonce, id: roomId, name, address }), peer.port, peer.address, () => {});
        }
      });
      receiver = udp;
    } catch (error) {
      try { udp.close(); } catch { /* 尚未绑定 */ }
      throw error;
    }
  }

  function stopUnused(address) {
    if (address === manualAddress || Array.from(online.values()).includes(address)) return;
    const listener = listeners.get(address);
    if (!listener) return;
    listener.tcp.close();
    listener.tcp.closeAllConnections();
    listeners.delete(address);
    if (!listeners.size && receiver) {
      receiver.close();
      receiver = null;
    }
  }

  function stopServer() {
    manualAddress = undefined;
    online.clear();
    for (const address of listeners.keys()) stopUnused(address);
  }

  function localHome() {
    return {
      hosted: store.rooms().map(info),
      joined: store.visits(),
      adapters: adapters(),
      preferredServerAdapter: store.preferredServerAdapter(),
      servers: Array.from(listeners.values(), ({ adapter }) => ({
        address: adapter.address, name: adapter.name, url: 'http://' + adapter.address + ':' + PORT,
      })),
    };
  }

  async function host(action, data) {
    if (closing) throw new RoomError(409, '应用正在退出');
    if (action === 'server-stop') {
      stopServer();
      return localHome();
    }
    if (action === 'pause') {
      const address = online.get(data.room);
      online.delete(data.room);
      stopUnused(address);
      return info(store.room(data.room));
    }
    const adapter = adapters().find(item => item.address === data.address);
    if (!adapter) throw new RoomError(400, '所选局域网网卡已不可用，请重新选择');
    const previous = action === 'resume' ? store.room(data.room) : null;
    await startAdapter(adapter);
    try {
      if (action === 'server-start') {
        store.rememberServerAdapter(adapter.name);
        const previousAddress = manualAddress;
        manualAddress = adapter.address;
        stopUnused(previousAddress);
        return localHome();
      }
      const row = previous || store.create(data.name, data.nickname, adapter.address, adapter.name);
      if (previous) store.address(row.id, adapter.address, adapter.name);
      const oldAddress = online.get(row.id);
      online.set(row.id, adapter.address);
      stopUnused(oldAddress);
      return info(store.room(row.id));
    } catch (error) {
      stopUnused(adapter.address);
      throw error;
    }
  }

  async function remote(origin, roomId, operation, payload, token) {
    const url = parseLink(origin + '/r/' + roomId);
    let response;
    try {
      response = await fetch(url.origin + '/api/r/' + roomId + '/' + operation, {
        method: operation === 'state' ? 'GET' : 'POST',
        headers: {
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
    } catch { throw new RoomError(503, '房主暂时离线。请稍后重试，或向房主索取新链接。'); }
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new RoomError(503, '房间服务返回了无法识别的响应');
    const result = await response.json();
    if (!response.ok) throw new RoomError(response.status, result.error || '房间暂时无法访问');
    return result;
  }

  async function dispatch(data) {
    const action = data.op;
    if (action === 'home') return localHome();
    if (action === 'discover') return (await discover()).filter(found => !online.has(found.id));
    if (action === 'directory') {
      const link = parseLink(data.url, true);
      if (link.room) return { link: data.url };
      let response;
      try {
        response = await fetch(link.origin + '/api/rooms', { redirect: 'error', signal: AbortSignal.timeout(4000) });
      } catch { throw new RoomError(503, '服务器暂时无法连接，请向房主确认当前地址'); }
      if (!response.ok) throw new RoomError(503, '服务器暂时无法连接，请向房主确认当前地址');
      let entries;
      try { entries = await response.json(); }
      catch { throw new RoomError(502, '这个地址没有提供可识别的房间列表'); }
      if (!Array.isArray(entries)) throw new RoomError(502, '这个地址没有提供可识别的房间列表');
      return { rooms: entries.filter(item => item && id.test(item.id) && typeof item.name === 'string' && item.name.length <= 60)
        .map(item => ({ name: item.name, url: link.origin + '/r/' + item.id })) };
    }
    if (action === 'cards') return await listCards(data.card, data.offset);
    if (['create', 'resume', 'pause', 'server-start', 'server-stop'].includes(action)) {
      const result = queue.then(() => host(action, data));
      queue = result.catch(() => {});
      return result;
    }
    if (action === 'join') {
      const link = parseLink(data.url);
      const saved = store.visit(link.room);
      if (saved && saved.origin === link.origin) {
        try {
          return await remote(link.origin, link.room, 'state', null, saved.token);
        } catch (error) { if (error.status !== 401) throw error; }
      }
      const result = await remote(link.origin, link.room, 'join', {
        invitation: link.invitation || data.code, nickname: data.nickname,
      });
      store.saveVisit(link.room, result.state.name, link.origin, result.token);
      return result.state;
    }
    if (!id.test(data.room)) throw new RoomError(400, '房间编号格式不正确');
    if (action === 'invite' || action === 'rotate') {
      const current = invite(data.room);
      if (action === 'invite') return current;
      store.rotate(data.room);
      return invite(data.room);
    }
    if (!memberOperations.has(action)) throw new RoomError(404, '操作不存在');
    if (data.owner === true) {
      if (!online.has(data.room)) throw new RoomError(503, '这个房间已暂停共享');
      return store.operate(data.room, store.authorize(data.room, null, true), action, data);
    }
    const visit = store.visit(data.room);
    if (!visit) throw new RoomError(401, '请先加入这个房间');
    return await remote(visit.origin, data.room, action, action === 'state' ? null : data, visit.token);
  }

  function close() {
    closing = true;
    stopServer();
    store.close();
  }
  return { dispatch, close };
}

module.exports = { createRoomService, adapters, parseLink, PORT };

