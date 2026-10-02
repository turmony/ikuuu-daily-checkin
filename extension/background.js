import {createSyncController} from './sync.js';

const controller=createSyncController(chrome);
// Content scripts can signal a login, but cannot read the device token.
const ready=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
const run=action=>ready.then(action).catch(()=>{});

chrome.cookies.onChanged.addListener(change=>{run(()=>controller.changed(change));});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='ikuuu-sync-retry')run(()=>controller.flush());});
chrome.runtime.onStartup.addListener(()=>{run(()=>controller.startup());});
chrome.runtime.onInstalled.addListener(()=>{run(()=>controller.startup());});

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  // A page/content script is only allowed to report its own authenticated page.
  if (sender.tab) {
    if (message?.type!=='site-login' || sender.id!==chrome.runtime.id) return false;
    run(()=>controller.login(sender)).then(()=>reply({ok:true}));
    return true;
  }
  if (sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('popup.html')) return false;
  ready.then(async()=>{
    if (message?.type==='status') return controller.status();
    if (message?.type==='configure') return controller.configure(message.config);
    if (message?.type==='forget') return controller.forget();
    if (message?.type==='sync-now') {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      return controller.manual(tab);
    }
    throw new Error('未知操作');
  }).then(data=>reply({ok:true,data}),error=>reply({ok:false,error:error.message}));
  return true;
});

run(()=>controller.startup());
