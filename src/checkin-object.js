import {DurableObject} from 'cloudflare:workers';
import {CheckinEngine, InputError} from './engine.js';

export class CheckinObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.engine=new CheckinEngine(ctx.storage,env);
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
  alarm() {return this.exclusive(()=>this.engine.alarm());}
}
