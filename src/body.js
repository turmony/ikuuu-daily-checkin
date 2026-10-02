export async function boundedText(response, limit) {
  if(Number(response.headers.get('content-length'))>limit) throw new Error('响应超过大小限制');
  if(!response.body) return '';
  const reader=response.body.getReader();
  const decoder=new TextDecoder(); let size=0, result='';
  try {
    while(true) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.byteLength;
      if(size>limit) {await reader.cancel();throw new Error('响应超过大小限制');}
      result+=decoder.decode(value,{stream:true});
    }
    return result+decoder.decode();
  } finally {reader.releaseLock();}
}
