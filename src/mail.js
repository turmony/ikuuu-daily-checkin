export class MailError extends Error {
  constructor(message, permanent = false) { super(message); this.permanent = permanent; }
}

const encode = text => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const address = value => typeof value === 'string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);

export function mailConfigured(env) {
  return !!(env.SMTP_HOST && env.MAIL_USER && env.MAIL_APP_PASSWORD && env.NOTIFY_TO);
}

// Tests inject a connector to exercise SMTP without sending real messages.
export async function sendNotification(env, notice, connector) {
  if (!mailConfigured(env)) throw new MailError('缺少 SMTP_HOST、MAIL_USER、MAIL_APP_PASSWORD 或 NOTIFY_TO', true);
  if (!address(env.MAIL_USER) || !address(env.NOTIFY_TO) || !/^[a-z0-9.-]+$/i.test(env.SMTP_HOST) || Number(env.SMTP_PORT || 465) !== 465) {
    throw new MailError('SMTP 地址无效：要求 TLS 465 端口和有效邮箱', true);
  }
  if (!connector) connector = (await import('cloudflare:sockets')).connect;
  let socket, reader, writer, timer;
  try {
    socket = connector({hostname:env.SMTP_HOST, port:465}, {secureTransport:'on'});
    socket.closed.catch(()=>{});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {socket.close().catch(()=>{}); reject(new MailError('SMTP 连接或发送超时'));},45_000);
    });
    const deliver = async () => {
      await socket.opened;
      reader=socket.readable.getReader(); writer=socket.writable.getWriter();
      let buffer='';
      const decoder=new TextDecoder();
      const line=async()=>{
        while(!buffer.includes('\r\n')) {
          const part=await reader.read();
          if(part.done) throw new MailError('SMTP 连接提前关闭');
          buffer+=decoder.decode(part.value,{stream:true});
          if(buffer.length>65_536) throw new MailError('SMTP 响应超过限制');
        }
        const end=buffer.indexOf('\r\n'); const result=buffer.slice(0,end); buffer=buffer.slice(end+2); return result;
      };
      const reply=async(expected, stage)=>{
        let code;
        for(let count=0;count<100;count++) {
          const value=await line(); const match=/^(\d{3})([ -])/.exec(value);
          if(!match || (code && code!==Number(match[1]))) throw new MailError('SMTP 响应格式异常');
          code=Number(match[1]);
          if(match[2]===' ') {
            if(!expected.includes(code)) throw new MailError(`SMTP ${stage}失败（${code}）`,code>=500);
            return;
          }
        }
        throw new MailError('SMTP 多行响应超过限制');
      };
      const command=async(text,expected,stage)=>{await writer.write(new TextEncoder().encode(text+'\r\n')); await reply(expected,stage);};
      await reply([220],'连接');
      await command('EHLO checkin.workers.dev',[250],'握手');
      await command('AUTH LOGIN',[334],'认证');
      await command(encode(env.MAIL_USER),[334],'认证');
      await command(encode(env.MAIL_APP_PASSWORD),[235],'认证');
      await command(`MAIL FROM:<${env.MAIL_USER}>`,[250],'发件地址');
      await command(`RCPT TO:<${env.NOTIFY_TO}>`,[250,251],'收件地址');
      await command('DATA',[354],'正文');
      const id=`${crypto.randomUUID()}@${env.MAIL_USER.split('@')[1]}`;
      const subject=String(notice.subject).replace(/[\r\n]/g,' ').slice(0,160);
      const text=String(notice.text).slice(0,32_000);
      const mime=[`From: <${env.MAIL_USER}>`,`To: <${env.NOTIFY_TO}>`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${id}>`,`Subject: =?UTF-8?B?${encode(subject)}?=`,
        'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',encode(text).match(/.{1,76}/g)?.join('\r\n') || ''].join('\r\n');
      await command(mime+'\r\n.',[250],'投递');
      // Do not retry after acceptance just because the connection cannot close cleanly.
      return id;
    };
    return await Promise.race([deliver(),timeout]);
  } catch(error) {
    if(error instanceof MailError) throw error;
    throw new MailError('SMTP 连接或协议通信失败');
  } finally {
    clearTimeout(timer);
    try {reader?.releaseLock();writer?.releaseLock();} catch { /* Timeout may leave a read pending. */ }
    if(socket) await socket.close().catch(()=>{});
  }
}
