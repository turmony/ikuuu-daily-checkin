import {DurableObject} from 'cloudflare:workers';
import {CheckinEngine, InputError} from './engine.js';
import {AuthManager} from './auth.js';

export class CheckinObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.engine=new CheckinEngine(ctx.storage,env);
    this.auth=new AuthManager(ctx.storage,env);
    this.pending=Promise.resolve();
  }
  // Serialize admin requests with alarms, including across external I/O awaits.
  exclusive(action) {
    const result=this.pending.then(action);
    this.pending=result.catch(()=>{});
    return result;
  }
  invoke(action) {
    return this.exclusive(async()=>{
      try {return {ok:true,data:await action()};}
      catch(error) {return {ok:false,status:error instanceof InputError ? error.status : 500,error:error instanceof InputError ? error.message : '服务配置或存储异常，请检查运行日志'};}
    });
  }
  status() {return this.invoke(()=>this.engine.status());}
  testEmail() {return this.invoke(()=>this.engine.testEmail());}
  updateCookie(cookie) {return this.invoke(()=>this.engine.updateCookie(cookie));}
  initialize(imported) {return this.invoke(()=>this.engine.initialize(imported));}
  runNow() {return this.invoke(()=>this.engine.runNow());}
  pause(paused) {return this.invoke(()=>this.engine.pause(paused));}
  authStatus(token) {return this.invoke(()=>this.auth.status(token));}
  login(password,clientKey) {return this.invoke(()=>this.auth.login(password,clientKey));}
  recover(code,password,clientKey) {return this.invoke(()=>this.auth.recover(code,password,clientKey));}
  changePassword(token,current,newPassword,clientKey) {return this.invoke(()=>this.auth.change(token,current,newPassword,clientKey));}
  logout(token) {return this.invoke(()=>this.auth.logout(token));}
  syncCookie(body,token) {
    return this.invoke(async()=>{
      const device=await this.auth.requireDevice(token);
      const result=await this.engine.syncCookie(body,device.id);
      await this.auth.recordDeviceSync(device.id);
      return result;
    });
  }
  manage(action,body,token) {
    return this.invoke(async()=>{
      // Validate in the same serialized operation as the action: no stale auth cache.
      await this.auth.requireSession(token);
      if(action==='status' || action==='history') return this.engine.status();
      if(action==='sync/devices') return this.auth.listDevices();
      if(action==='sync/pair') {
        const result=await this.auth.pairDevice(body.name);
        await this.engine.useBrowserSync();
        return result;
      }
      if(action==='sync/revoke') return this.auth.revokeDevice(body.id);
      if(action==='cookie') return this.engine.updateCookie(body.cookie);
      if(action==='renew-cookie') return this.engine.renewCookie();
      if(action==='initialize') return this.engine.initialize(body);
      if(action==='run') return this.engine.runNow();
      if(action==='test-email') return this.engine.testEmail();
      if(action==='pause' || action==='resume') return this.engine.pause(action==='pause');
      throw new InputError('接口不存在',404);
    });
  }
  alarm() {return this.exclusive(()=>this.engine.alarm());}
}
