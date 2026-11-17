const path=require('node:path');
require('./p3-fixture.cjs')(path.resolve(__dirname,'..')).then(({server,url})=>{
  console.log('隔离预览：'+url+'/styleguide');
  console.log('仅使用样例数据，不连接生产服务。Ctrl+C 关闭。');
  process.on('SIGINT',async()=>{await server.close();process.exit(0);});
}).catch(e=>{console.error(e);process.exitCode=1;});
