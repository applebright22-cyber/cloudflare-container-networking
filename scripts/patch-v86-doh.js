const fs = require("node:fs");
const path = "public/v86/libv86.js";
const source = fs.readFileSync(path, "utf8");
const start = source.indexOf("function Jb(a,b){");
const end = source.indexOf("\nfunction Kb", start);
if (start < 0 || end <= start) throw new Error("Could not locate the v86 DNS-over-HTTPS handler; refusing to publish an unpatched runtime.");
const handler = [
"function Jb(a,b){",
"(async function(){",
"const primary=b.doh_server||\u0027cloudflare-dns.com\u0027;",
"const resolvers=[primary,\u0027dns.google\u0027].filter((host,index,list)=>host&&list.indexOf(host)===index);",
"for(const resolver of resolvers){",
"try{",
"const response=await fetch(\u0027https://\u0027+resolver+\u0027/dns-query\u0027,{method:\u0027POST\u0027,headers:{\u0027content-type\u0027:\u0027application/dns-message\u0027,\u0027accept\u0027:\u0027application/dns-message\u0027},body:a.udp.data});",
"if(!response||!response.ok)continue;",
"const contentType=response.headers&&response.headers.get?response.headers.get(\u0027content-type\u0027)||\u0027\u0027:\u0027\u0027;",
"if(!/^application\\\\/dns-message(?:\\\\s*;|\\\\s*$)/i.test(contentType))continue;",
"const bytes=new Uint8Array(await response.arrayBuffer());",
"if(bytes.length<12)continue;",
"const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);",
"if(view.getUint16(0)!==a.dns.id)continue;",
"const flags=view.getUint16(2);",
"if(!(flags&32768))continue;",
"if(view.getUint16(4)!==a.dns.questions.length)continue;",
"if((flags&15)===2)continue;",
"const packet={eth:{ethertype:2048,src:b.router_mac,dest:a.eth.src},ipv4:{proto:17,src:b.router_ip,dest:a.ipv4.src},udp:{sport:53,dport:a.udp.sport,data:bytes}};",
"b.receive(Ib(b.eth_encoder_buf,packet));",
"return;",
"}catch(error){}",
"}",
"const failure={eth:{ethertype:2048,src:b.router_mac,dest:a.eth.src},ipv4:{proto:17,src:b.router_ip,dest:a.ipv4.src},udp:{sport:53,dport:a.udp.sport},dns:{id:a.dns.id,flags:33154,questions:a.dns.questions,answers:[]}};",
"b.receive(Ib(b.eth_encoder_buf,failure));",
""})();",
"return!0",
"].join("\n");
fs.writeFileSync(path, source.slice(0, start) + handler + source.slice(end));
console.log("Restored Cloudflare-to-Google DoH failover in " + path);
