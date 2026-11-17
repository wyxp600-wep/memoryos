/** 显式数据库路径是硬门禁，禁止默认触及生产库。 */
import path from 'node:path';
import { openDb,backupDb } from './db.js';
import { storageStatus,restoreBundle,validateBundle,exportLegacy,StorageConnection } from './storage.js';
const [command,...args]=process.argv.slice(2);
try {
  if(!command||!args[0])throw new Error('用法：storage-cli.js migrate|status|backup <数据库绝对路径>；verify <备份目录>；restore|export-legacy <备份目录> <新目标目录或文件>');
  if(!path.isAbsolute(args[0]))throw new Error('必须使用绝对路径，避免连接错误数据库');
  if(command==='verify')console.log(JSON.stringify(validateBundle(args[0]),null,2));
  else if(command==='restore'||command==='export-legacy') {
    if(!args[1]||!path.isAbsolute(args[1]))throw new Error('必须指定尚不存在的绝对目标路径');
    console.log(command==='restore'?restoreBundle(args[0],args[1]):exportLegacy(args[0],args[1]));
  }else if(['migrate','status','backup'].includes(command)) {
    const db=command==='migrate'?openDb(args[0]):new StorageConnection(args[0],{readOnly:command==='status'});
    try{console.log(JSON.stringify(command==='backup'?backupDb(db,args[0]):storageStatus(db),null,2));}finally{db.close();}
  }else throw new Error('未知操作：'+command);
}catch(e){console.error('存储操作失败：'+e.message);process.exitCode=1;}
