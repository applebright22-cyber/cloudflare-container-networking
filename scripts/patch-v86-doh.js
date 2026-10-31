const fs = require("node:fs");
const path = "public/v86/libv86.js";
const source = fs.readFileSync(path, "utf8");
const start = source.indexOf("function Jb(a,b){");
const end = source.indexOf("\nfunction Kb", start);
if (start < 0 || end <= start) throw new Error("Could not locate the v86 DNS-over-HTTPS handler; refusing to publish an unpatched runtime.");
const handler = [
"function Jb(a,b){",
"const query=new Uint8Array(a.udp.data);",
"const queryId=a.dns.id;",
"const questions=a.dns.questions.map(question=>({...question}));",
"const guestMac=a.eth.src;",
"const guestIp=a.ipv4.src;",
"const guestPort=a.udp.sport;",
"const routerMac=b.router_mac;",
"const routerIp=b.router_ip;",
"const encoder=b.eth_encoder_buf;",
"(async function(){",
"const primary=b.doh_server||'cloudflare-dns.com';",
"const resolvers=[primary,'dns.google'].filter((host,index,list)=>host&&list.indexOf(host)===index);",
"for(const resolver of resolvers){",
"const controller=new AbortController();",
"const timeoutMs=Number.isFinite(b.doh_timeout_ms)&&b.doh_timeout_ms>0?Math.min(b.doh_timeout_ms,3000):3000;",
"const timeoutId=setTimeout(()=>controller.abort(),timeoutMs);",
"try{",
"const response=await fetch('https://'+resolver+'/dns-query',{method:'POST',headers:{'content-type':'application/dns-message','accept':'application/dns-message'},body:query,signal:controller.signal});",
"if(!response||!response.ok)continue;",
"const contentType=response.headers&&response.headers.get?response.headers.get('content-type')||'':'';",
"if(!/^application\\/dns-message(?:\\s*;|\\s*$)/i.test(contentType))continue;",
"const bytes=new Uint8Array(await response.arrayBuffer());",
"if(bytes.length<12)continue;",
"const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);",
"if(view.getUint16(0)!==queryId)continue;",
"const flags=view.getUint16(2);",
"if(!(flags&32768))continue;",
"if(((flags>>>11)&15)!==((query[2]>>>3)&15))continue;",
"if(view.getUint16(4)!==questions.length)continue;",
"if((flags&15)===2)continue;",
"const packet={eth:{ethertype:2048,src:routerMac,dest:guestMac},ipv4:{proto:17,src:routerIp,dest:guestIp},udp:{sport:53,dport:guestPort,data:bytes}};",
"b.receive(Ib(encoder,packet));",
"return;",
"}catch(error){}",
"finally{clearTimeout(timeoutId);}",
"}",
"const failure={eth:{ethertype:2048,src:routerMac,dest:guestMac},ipv4:{proto:17,src:routerIp,dest:guestIp},udp:{sport:53,dport:guestPort},dns:{id:queryId,flags:33154,questions,answers:[]}};",
"b.receive(Ib(encoder,failure));",
"})();",
"return!0}"
].join("\n");
fs.writeFileSync(path, source.slice(0, start) + handler + source.slice(end));
console.log("Restored Cloudflare-to-Google DoH failover in " + path);
