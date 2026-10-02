import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendNotification} from '../src/mail.js';

const env={SMTP_HOST:'smtp.126.com',SMTP_PORT:'465',MAIL_USER:'user@example.com',MAIL_APP_PASSWORD:'test-secret',NOTIFY_TO:'user@example.com'};
function server(fail) {
  const writes=[]; let controller;
  const send=text=>controller.enqueue(new TextEncoder().encode(text));
  const socket={opened:Promise.resolve(),closed:Promise.resolve(),close:async()=>{},
    readable:new ReadableStream({start(c){controller=c;send('220 smtp.test ready\r\n');}}),
    writable:new WritableStream({write(bytes){
      const command=new TextDecoder().decode(bytes); writes.push(command);
      if(command.startsWith('EHLO')) send('250-smtp.test\r\n250 AUTH LOGIN\r\n');
      else if(command==='AUTH LOGIN\r\n') send('334 VXNlcm5hbWU6\r\n');
      else if(command===btoa(env.MAIL_USER)+'\r\n') send('334 UGFzc3dvcmQ6\r\n');
      else if(command===btoa(env.MAIL_APP_PASSWORD)+'\r\n') send(fail==='auth'?'535 Invalid credentials\r\n':'235 Authenticated\r\n');
      else if(command.startsWith('RCPT')) send(fail==='temp'?'450 Try later\r\n':'250 OK\r\n');
      else if(command==='DATA\r\n') send('354 Send data\r\n');
      else send('250 Accepted\r\n');
    }})};
  return {writes,connect:(addr,options)=>{assert.equal(addr.port,465);assert.equal(options.secureTransport,'on');return socket;}};
}

test('SMTP uses TLS, authenticates and sends UTF-8 MIME safely',async()=>{
  const mock=server();
  const id=await sendNotification(env,{subject:'签到失败\r\nBcc: other@test.com',text:'Cookie 已失效'},mock.connect);
  assert.match(id,/@example\.com$/);
  const data=mock.writes.at(-1);
  assert.match(data,/Content-Transfer-Encoding: base64/);
  assert.ok(data.endsWith('\r\n.\r\n'));
  assert.ok(!data.includes('\r\nBcc:'));
  assert.ok(!data.includes(env.MAIL_APP_PASSWORD));
});
test('authentication errors are permanent and never include server details or secret',async()=>{
  await assert.rejects(()=>sendNotification(env,{subject:'test',text:'test'},server('auth').connect),error=>error.permanent && error.message==='SMTP 认证失败（535）');
});
test('SMTP 4xx remains retryable',async()=>{
  await assert.rejects(()=>sendNotification(env,{subject:'test',text:'test'},server('temp').connect),error=>!error.permanent);
});
test('unconfigured credentials fail before connecting',async()=>{
  await assert.rejects(()=>sendNotification({...env,MAIL_APP_PASSWORD:''},{subject:'test',text:'test'},()=>{throw Error('must not connect');}),error=>error.permanent);
});
