(() => {
  let reported=false;
  const report=()=>{
    if (reported || !/^\/user(?:\/|$)/.test(location.pathname) || !document.body?.textContent.includes('剩余流量')) return;
    reported=true;observer.disconnect();clearTimeout(timeout);
    // Never read Cookie or receive pairing credentials in the website context.
    chrome.runtime.sendMessage({type:'site-login'}).catch(()=>{});
  };
  const observer=new MutationObserver(report);
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  const timeout=setTimeout(()=>observer.disconnect(),30_000);
  report();
})();
