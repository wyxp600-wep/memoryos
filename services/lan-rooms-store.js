'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, createHash } = require('node:crypto');

const id = /^[a-f0-9-]{36}$/;
const secret = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function field(value, limit, label, required = true) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new RoomError(400, label + '格式不正确');
  }
  return value.trim();
}

function createStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, invite TEXT NOT NULL, address TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','member')), credential TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id),
      publisher TEXT NOT NULL REFERENCES members(id), assignee TEXT REFERENCES members(id),
      title TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ready','active','done')),
      created TEXT NOT NULL, changed TEXT NOT NULL,
      request TEXT NOT NULL, UNIQUE (room, publisher, request)
    );
    CREATE TABLE IF NOT EXISTS visits (
      room TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, token TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_preference (
      id INTEGER PRIMARY KEY CHECK (id=1), adapter TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(rooms)').all().some(column => column.name === 'adapter')) {
    db.exec("ALTER TABLE rooms ADD COLUMN adapter TEXT NOT NULL DEFAULT ''");
  }
  const findRoom = db.prepare('SELECT * FROM rooms WHERE id=?');
  const findOwner = db.prepare("SELECT id, name, role FROM members WHERE room=? AND role='owner'");
  const findGuest = db.prepare("SELECT id, name, role FROM members WHERE room=? AND credential=? AND role='member'");
  const memberInfo = db.prepare('SELECT id,name,role FROM members WHERE room=? ORDER BY role DESC, name');
  const taskList = db.prepare(`
    SELECT t.id, t.title, t.body, t.status, t.publisher, t.assignee, t.created, t.changed,
           p.name AS publisherName, a.name AS assigneeName
    FROM tasks t JOIN members p ON p.id=t.publisher LEFT JOIN members a ON a.id=t.assignee
    WHERE t.room=? ORDER BY t.created DESC, t.id
  `);
  const insertTask = db.prepare(`
    INSERT INTO tasks (id,room,publisher,title,body,status,created,changed,request)
    VALUES (?,?,?,?,?,'ready',?,?,?) ON CONFLICT(room,publisher,request) DO NOTHING
  `);
  const claim = db.prepare("UPDATE tasks SET status='active',assignee=?,changed=? WHERE room=? AND id=? AND status='ready'");
  const release = db.prepare("UPDATE tasks SET status='ready',assignee=NULL,changed=? WHERE room=? AND id=? AND status='active' AND (assignee=? OR ?='owner')");
  const finish = db.prepare("UPDATE tasks SET status='done',changed=? WHERE room=? AND id=? AND status='active' AND assignee=?");
  const existingTask = db.prepare('SELECT title,body FROM tasks WHERE room=? AND publisher=? AND request=?');

  function room(roomId) {
    const row = findRoom.get(roomId);
    if (!row) throw new RoomError(404, '房间不存在');
    return row;
  }

  function create(name, nickname, address, adapter) {
    name = field(name, 60, '房间名');
    nickname = field(nickname, 32, '昵称');
    const roomId = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO rooms (id,name,invite,address,adapter) VALUES (?,?,?,?,?)').run(roomId, name, secret(), address, adapter);
      db.prepare("INSERT INTO members VALUES (?,?,?,'owner',NULL)").run(randomUUID(), roomId, nickname);
      db.exec('COMMIT');
      return room(roomId);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function join(roomId, invitation, nickname) {
    const entry = room(roomId);
    if (typeof invitation !== 'string' || invitation.length !== 32 || hash(invitation) !== hash(entry.invite)) {
      throw new RoomError(403, '邀请码有误或已经更新');
    }
    const token = secret();
    db.prepare("INSERT INTO members VALUES (?,?,?,'member',?)").run(
      randomUUID(), roomId, field(nickname, 32, '昵称'), hash(token)
    );
    return token;
  }

  function authorize(roomId, token, owner) {
    room(roomId);
    if (owner) return findOwner.get(roomId);
    const actor = typeof token === 'string' && token.length === 32 ? findGuest.get(roomId, hash(token)) : null;
    if (!actor) throw new RoomError(401, '会话已失效，请使用邀请码重新加入');
    return actor;
  }

  function state(roomId, actor) {
    const { name } = room(roomId);
    return { id: roomId, name, me: actor, members: memberInfo.all(roomId), tasks: taskList.all(roomId) };
  }

  function operate(roomId, actor, operation, data) {
    if (operation === 'state') return state(roomId, actor);
    if (operation === 'publish') {
      if (typeof data.request !== 'string' || !/^[\w-]{16,80}$/.test(data.request)) throw new RoomError(400, '发布编号格式不正确');
      const title = field(data.title, 160, '标题');
      const body = field(data.body, 12000, '说明', false);
      const timestamp = now();
      insertTask.run(randomUUID(), roomId, actor.id, title, body, timestamp, timestamp, data.request);
      const existing = existingTask.get(roomId, actor.id, data.request);
      if (existing.title !== title || existing.body !== body) throw new RoomError(409, '这次发布的内容与原请求不同');
      return state(roomId, actor);
    }
    if (typeof data.task !== 'string' || !id.test(data.task)) throw new RoomError(400, '任务编号格式不正确');
    let result;
    if (operation === 'claim') result = claim.run(actor.id, now(), roomId, data.task);
    else if (operation === 'release') result = release.run(now(), roomId, data.task, actor.id, actor.role);
    else if (operation === 'finish') result = finish.run(now(), roomId, data.task, actor.id);
    else throw new RoomError(404, '操作不存在');
    if (result.changes !== 1) throw new RoomError(409, '任务状态已变化，或你没有操作权限');
    return state(roomId, actor);
  }

  return {
    room, create, join, authorize, operate,
    rooms: () => db.prepare('SELECT * FROM rooms ORDER BY name').all(),
    preferredServerAdapter: () => db.prepare('SELECT adapter FROM server_preference WHERE id=1').get()?.adapter || '',
    rememberServerAdapter: adapter => db.prepare('INSERT OR REPLACE INTO server_preference (id,adapter) VALUES (1,?)').run(adapter),
    rotate: roomId => db.prepare('UPDATE rooms SET invite=? WHERE id=?').run(secret(), roomId),
    address: (roomId, address, adapter) => db.prepare('UPDATE rooms SET address=?,adapter=? WHERE id=?').run(address, adapter, roomId),
    visits: () => db.prepare('SELECT room, name, origin FROM visits ORDER BY name').all(),
    visit: roomId => db.prepare('SELECT * FROM visits WHERE room=?').get(roomId),
    saveVisit: (roomId, name, origin, token) => db.prepare('INSERT OR REPLACE INTO visits VALUES (?,?,?,?)').run(roomId, name, origin, token),
    close: () => db.close(),
  };
}

module.exports = { createStore, RoomError, id };

