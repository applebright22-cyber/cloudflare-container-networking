(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
const accountId=(()=>{try{return sessionStorage.getItem('vm-account-id')||'guest'}catch{return 'guest'}})();
const sessionToken=(()=>{try{return sessionStorage.getItem('vm-session-token')||''}catch{return ''}})();
const KEY='vampiresquid-studio-projects-v1:'+accountId;
let projects=[];try{projects=JSON.parse(localStorage.getItem(KEY)||'[]');if(!Array.isArray(projects))projects=[]}catch{projects=[]}
let activeId=null,selectedSectionId=null,toastTimer,previewStockroomProducts=[];
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function persist(){try{localStorage.setItem(KEY,JSON.stringify(projects));return true}catch{return false}}
function authHeaders(){const token=(()=>{try{return sessionStorage.getItem('vm-session-token')||''}catch{return ''}})();return {'content-type':'application/json','authorization':'Bearer '+token}}
function cloudUrl(path=''){return '/api/studio/projects'+path+'?account_id='+encodeURIComponent(accountId)}
window.addEventListener('message',event=>{const frame=$('#site-canvas');if(!frame||event.source!==frame.contentWindow)return;const message=event.data;if(!message||message.type!=='vs-preview-storage-write'||typeof message.projectId!=='string'||!message.value||typeof message.value!=='object'||Array.isArray(message.value))return;const project=projects.find(item=>item.id===message.projectId);if(!project||project.id!==activeId)return;let serialized;try{serialized=JSON.stringify(message.value)}catch{return}if(serialized.length>500000)return;project.data=project.data&&typeof project.data==='object'?project.data:{};project.data.previewStorage=message.value;project.updated=new Date().toISOString();persist();if(sessionToken&&accountId!=='guest')syncProject(project)});
async function syncProject(project){if(!sessionToken||!accountId||accountId==='guest')return false;try{const r=await fetch(cloudUrl('/'+encodeURIComponent(project.id)),{method:'PUT',headers:authHeaders(),body:JSON.stringify(project)});if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||'Cloud save failed ('+r.status+')')}project.cloudSaved=true;persist();return true}catch(e){project.cloudSaved=false;toast('Saved in this browser. Cloud sync: '+e.message);return false}}
async function loadCloudProjects(){if(!sessionToken||!accountId||accountId==='guest')return;try{const r=await fetch(cloudUrl(),{headers:authHeaders()});if(!r.ok)throw new Error('Cloud storage unavailable ('+r.status+')');const data=await r.json();const removed=deletedIds();const remote=(Array.isArray(data.projects)?data.projects:[]).filter(p=>!removed.has(p.id));const merged=new Map(projects.filter(p=>!removed.has(p.id)).map(p=>[p.id,p]));for(const p of remote){const local=merged.get(p.id);if(!local||String(p.updated||'')>=String(local.updated||''))merged.set(p.id,{...p,cloudSaved:true})}projects=Array.from(merged.values()).sort((a,b)=>String(b.updated||'').localeCompare(String(a.updated||'')));migrateLegacyVisualProjects();persist();renderProjects();const bytes=Number(data.usage?.bytes||0);const limit=Number(data.usage?.limit_bytes||20971520);const el=$('#cloud-storage-status');if(el)el.textContent=(remote.length+' cloud projects · '+(bytes/1048576).toFixed(2)+' / '+(limit/1048576).toFixed(0)+' MB used');const used=$('#storage-used');const foot=$('#storage-foot');if(used)used.textContent=(bytes/1048576).toFixed(2)+' MB';if(foot)foot.textContent=(limit/1048576).toFixed(0)+' MB account allowance';for(const p of projects){if(!p.cloudSaved)await syncProject(p)}toast('Cloud projects loaded and synchronized.');await ensureOracleDemoProject();void initializeStockroomDatabase()}catch(e){const el=$('#cloud-storage-status');if(el)el.textContent='Cloud storage unavailable: '+e.message}}

async function ensureOracleDemoProject(){if(accountId!=='acct-0330bf66-258b-43b5-ae56-06959b936655'||!sessionToken||projects.some(p=>p.id==='vs-oracle-network-hub-demo'))return;const now=new Date().toISOString();const p={id:'vs-oracle-network-hub-demo',name:'Oracle Business Network Hub',kind:'Business application · Oracle',created:now,updated:now,title:'Business Network Hub',description:'TinyCore guest networking connected to the Oracle execution bridge.',button:'Open TinyCore',accent:'#00d5ff',bg:'#10152b',files:businessTemplateFiles('Oracle'),plugins:['oracle-bridge-status'],cloudSaved:false};projects.unshift(p);persist();renderProjects();await syncProject(p);renderProjects();toast('Oracle Business Network Hub added to your projects.');}
function toast(message){const el=$('#toast');if(!el)return;el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2600)}
function id(){return 'vs-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)}
function openView(name){$$('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+name));$$('.side-nav [data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));const label={dashboard:'Dashboard',stockroom:'Stockroom',projects:'My projects',templates:'Templates',editor:'Website editor',publishing:'Publishing',storage:'Storage',billing:'Billing',settings:'Settings'};$('#page-title').textContent=label[name]||'Dashboard';if(name==='projects')renderProjects();if(name==='stockroom')renderStockroom();if(name==='editor'){syncProjectSelect();loadEditor()}if(name==='settings')loadPaymentSettings();if(name==='publishing')loadPublishOptions(); }
function projectCard(p){return '<article class="project-card"><div class="project-thumb" style="background:'+escapeHtml(p.bg||'#263c72')+'">✦</div><span class="status-chip draft">'+(p.cloudSaved?'CLOUD SAVED':'LOCAL DRAFT')+'</span><h3>'+escapeHtml(p.name)+'</h3><p>'+escapeHtml(p.kind)+' · Updated '+new Date(p.updated).toLocaleDateString()+'</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="button button-ghost" data-edit="'+escapeHtml(p.id)+'">Open editor →</button><button class="button button-ghost" data-duplicate="'+escapeHtml(p.id)+'">Duplicate</button><button class="button button-ghost" data-delete="'+escapeHtml(p.id)+'">Delete</button></div></article>'}
function row(p){return '<div class="project-row"><div class="project-thumb">✦</div><div class="project-meta"><b>'+escapeHtml(p.name)+'</b><small>'+escapeHtml(p.kind)+' · '+(p.cloudSaved?'Saved in cloud':'Browser draft')+'</small></div><span class="status-chip draft">DRAFT</span><button class="link-button" data-edit="'+escapeHtml(p.id)+'">Open →</button></div>'}
function updateDashboardPreview(){const frame=$('#dashboard-preview');if(!frame)return;const project=projects[0];frame.srcdoc=project?previewDoc(project):'<!doctype html><html><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10182d;color:#b9c6df;font:14px system-ui,sans-serif"><p>Create a project to see your website preview here.</p></body></html>'}
function renderProjects(){const all=$('#all-projects'),empty=$('#projects-empty'),recent=$('#recent-projects'),recentEmpty=$('#empty-projects');if(all){all.innerHTML=projects.map(projectCard).join('');empty.classList.toggle('visible',projects.length===0)}if(recent){recent.innerHTML=projects.slice(0,4).map(row).join('');recentEmpty.classList.toggle('visible',projects.length===0)}$('#project-count').textContent=projects.length;syncProjectSelect();updateDashboardPreview()}
function syncProjectSelect(){const select=$('#editor-project');if(!select)return;select.innerHTML=projects.map(p=>'<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</option>').join('');if(activeId&&projects.some(p=>p.id===activeId))select.value=activeId;else if(projects[0]){activeId=projects[0].id;select.value=activeId}}
function openModal(name=''){const modal=$('#new-modal');modal.hidden=false;$('#project-name').value=name;$('#project-name').focus()}
function closeModal(){$('#new-modal').hidden=true}
function storefrontTemplateFiles(){
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Good Goods</title><link rel="stylesheet" href="styles.css"></head><body><div class="ribbon">FREE SHIPPING OVER $60 · THE EVERYDAY EDIT</div><nav><b>GOOD<span>GOODS</span></b><a href="#shop">Shop</a><a href="#story">Our story</a><button id="bag" type="button">Bag <i id="count">0</i></button><button id="checkout-nav" type="button">Checkout</button></nav><header><div><small>THE LITTLE THINGS COLLECTION</small><h1>Everyday things.<br><em>A little more lovely.</em></h1><p>Thoughtful objects, cheerful colors, and useful things that brighten your day.</p><a class="cta" href="#shop">Shop the collection ↗</a><p class="note">✳ Designed with care · Packed with joy</p></div><div class="hero-art"><svg viewBox="0 0 400 340" role="img" aria-label="Cheerful flower vase illustration"><circle cx="205" cy="165" r="145" fill="#f4dcae"/><path d="M200 235Q190 135 120 65M200 210Q240 115 300 65M200 210Q145 155 75 145" fill="none" stroke="#59785c" stroke-width="8"/><g fill="#ec8a73"><circle cx="120" cy="65" r="23"/><circle cx="300" cy="65" r="25"/><circle cx="75" cy="145" r="22"/></g><g fill="#f8ce6d"><circle cx="120" cy="65" r="8"/><circle cx="300" cy="65" r="8"/><circle cx="75" cy="145" r="8"/></g><path d="M140 210Q130 295 165 315Q205 330 245 315Q270 270 255 210Z" fill="#df856b"/><path d="M145 220Q200 240 253 220" fill="none" stroke="#ffe6c6" stroke-width="7"/></svg><b>GOOD<br>VIBES ✳</b></div></header><main id="shop"><small>CURATED FOR YOU</small><h2>Small joys, big energy.</h2><div class="products" id="products-grid"><article><div class="art peach">☀️<span>☕</span></div><h3>Sunshine Mug</h3><p>Hand-finished ceramic · $24</p><button data-product-id="sunshine-mug" data-name="Sunshine Mug" data-price="24">Add to bag +</button></article><article><div class="art green">🌼<span>👜</span></div><h3>Petal Market Tote</h3><p>Everyday cotton carryall · $32</p><button data-product-id="petal-market-tote" data-name="Petal Market Tote" data-price="32">Add to bag +</button></article><article><div class="art yellow">🕯️</div><h3>Little Sunshine Candle</h3><p>Citrus + warm vanilla · $28</p><button data-product-id="little-sunshine-candle" data-name="Little Sunshine Candle" data-price="28">Add to bag +</button></article><article><div class="art lilac">✿<span>📓</span></div><h3>Happy Days Notebook</h3><p>Ideas, lists & daydreams · $18</p><button data-product-id="happy-days-notebook" data-name="Happy Days Notebook" data-price="18">Add to bag +</button></article></div></main><section id="story"><div class="sticker">MAKE ROOM<br>FOR HAPPY ✿</div><div><small>A NOTE FROM OUR STUDIO</small><h2>Useful can be beautiful.</h2><p>Good Goods is an editable storefront starter. Change the products, prices, colors, illustrations, and story to make it yours.</p></div></section><footer>GOOD GOODS © 2026 <span>MADE WITH A LITTLE EXTRA LOVE ✳</span></footer><aside id="drawer"><button id="close">×</button><h2>Your bag</h2><div id="items">Your bag is empty.</div><b id="total">$0.00</b><button id="checkout">Continue to secure checkout</button><p id="checkout-status" role="status" aria-live="polite"></p><small>Checkout methods appear here after the merchant enables PayPal or Base USDC.</small></aside><script src="app.js"></script><script src="/stockroom-storefront.js" defer></script></body></html>';
 const css='*{box-sizing:border-box}body{margin:0;background:#fffaf1;color:#2b4032;font:15px/1.6 system-ui,sans-serif}.ribbon{text-align:center;background:#294333;color:white;padding:8px;font-size:10px;letter-spacing:1px}nav{height:70px;padding:0 7%;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #eee2d4}nav b{font-size:22px}nav b span{color:#e98570}nav a{color:#405342;text-decoration:none}button,.cta{cursor:pointer;border:0;border-radius:5px;padding:11px 16px;background:#304b39;color:white;font-weight:700;text-decoration:none}header{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:center;padding:65px 9%;background:#f7efdf}small{color:#dc806a;letter-spacing:2px;font-weight:800;font-size:10px}h1{font:700 clamp(40px,6vw,68px)/1.05 Georgia,serif;margin:15px 0}h1 em{color:#df8068}header p{color:#687568;max-width:440px}.note{font-size:11px}.hero-art{position:relative;max-width:430px;margin:auto}.hero-art svg{width:100%}.hero-art b{position:absolute;right:0;bottom:25px;background:#e98972;color:white;border-radius:50%;padding:25px;transform:rotate(8deg);font-size:12px}main{padding:65px 8%}h2{font:700 36px Georgia,serif}.products{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.products article{min-width:0}.art{height:205px;border-radius:7px;display:grid;place-items:center;font-size:48px;position:relative}.art span{font-size:66px}.peach{background:#f4d8c7}.green{background:#dfe9d9}.yellow{background:#f4e7b9}.lilac{background:#e4def0}h3{font-size:14px;margin:12px 0 2px}.products p{font-size:11px;color:#788273;margin:0 0 12px}.products button{width:100%;background:transparent;color:#304b39;border:1px solid #bdc8b8}#story{padding:65px 10%;background:#e9eee3;display:flex;align-items:center;gap:8%}#story p{max-width:500px;color:#687568}.sticker{width:200px;height:200px;flex:none;border-radius:50%;background:#dca18b;color:white;display:grid;place-items:center;text-align:center;font:700 25px Georgia}footer{padding:24px 8%;background:#294333;color:white;display:flex;justify-content:space-between;font-size:10px}#drawer{position:fixed;z-index:4;right:0;top:0;height:100dvh;width:min(370px,100%);padding:25px;background:#fffaf1;box-shadow:0 0 40px #0003;transform:translateX(110%);transition:.2s;display:flex;flex-direction:column;gap:15px}#drawer.open{transform:none}#drawer #close,#dismiss{align-self:flex-end;background:transparent;color:#294333;font-size:24px;padding:0}#total{margin-top:auto}#drawer small{font-size:9px;letter-spacing:0;color:#687568}#modal{display:none;position:fixed;inset:0;z-index:8;background:#0008;place-items:center;padding:15px}#modal.open{display:grid}.modal-card{position:relative;width:min(450px,100%);max-height:90dvh;overflow:auto;background:#fffaf1;padding:25px;border-radius:10px}.modal-card article{padding:12px;border:1px solid #ddd5c7;border-radius:7px;margin:10px 0}.modal-card article p{font-size:12px;color:#687568}.modal-card article button{font-size:12px}#steps{background:#e9eee3;padding:12px;margin:12px 0;border-radius:6px;font-size:12px}@media(max-width:750px){header{grid-template-columns:1fr;padding:48px 7%}.hero-art{max-width:320px}.products{grid-template-columns:repeat(2,minmax(0,1fr))}#story{display:block}#story .sticker{margin:0 auto 25px}nav{padding:0 5%}nav a{font-size:12px}}@media(max-width:430px){.art{height:150px}main{padding:45px 5%}footer{display:block;text-align:center}footer span{display:block;margin-top:7px}}';
 const js="const cart=[];const money=n=>'$'+Number(n).toFixed(2);const drawer=document.getElementById('drawer');function render(){const count=document.getElementById('count'),items=document.getElementById('items'),total=document.getElementById('total');if(count)count.textContent=cart.reduce((n,x)=>n+x.quantity,0);if(items)items.innerHTML=cart.length?cart.map(x=>'<p>'+x.name+' × '+x.quantity+' — '+money(x.price*x.quantity)+'</p>').join(''):'Your bag is empty.';if(total)total.textContent=money(cart.reduce((n,x)=>n+x.price*x.quantity,0));}document.querySelector('.products')?.addEventListener('click',event=>{const b=event.target.closest('[data-product-id]');if(!b||b.disabled)return;const product_id=b.dataset.productId,name=b.dataset.name,price=Number(b.dataset.price),found=cart.find(x=>x.product_id===product_id);if(found)found.quantity++;else cart.push({product_id,name,price,quantity:1});render();drawer?.classList.add('open')});document.getElementById('bag')?.addEventListener('click',()=>drawer?.classList.add('open'));document.getElementById('checkout-nav')?.addEventListener('click',()=>{drawer?.classList.add('open');const status=document.getElementById('checkout-status');if(status&&!cart.length)status.textContent='Add at least one product before checkout.';});document.getElementById('close')?.addEventListener('click',()=>drawer?.classList.remove('open'));document.getElementById('checkout')?.addEventListener('click',async()=>{if(!cart.length)return;const status=document.getElementById('checkout-status');if(status)status.textContent='Preparing secure checkout with the merchant’s enabled payment methods…';const match=location.pathname.match(/^\\/sites\\/([a-f0-9]{32})\\/?$/);if(!match){if(status)status.textContent='Publish this store to enable live customer checkout.';return}try{const response=await fetch('/api/payments/public/checkout/'+match[1],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:cart.map(x=>({product_id:x.product_id,quantity:x.quantity}))})});const result=await response.json();if(!response.ok)throw Error(result.error||'Checkout could not be created');location.href=result.url}catch(error){if(status)status.textContent=error.message}});render();";
 return {_title:'Good Goods · Storefront Demo',_description:'Illustrated storefront with editable products, cart, and PayPal/USDC checkout walkthrough. Preview mode never charges a payment method.','index.html':html,'styles.css':css,'app.js':js};
}
function visualTemplateFiles(kind){
 const data={Cafe:['THE DAILY POUR','Coffee worth slowing down for.','Fresh coffee, thoughtful food, and a warm place to land.','#c87945','#f5eadc','A good day starts here'],Agency:['NORTH / STUDIO','Make your next move matter.','Strategy, design, and digital experiences that turn ambitious ideas into meaningful growth.','#b7f36b','#101712','Clarity before everything'],Portfolio:['SELECTED WORK','Ideas made visible.','A curated collection of work, experiments, and things made with purpose.','#ff775e','#f0eee8','Featured projects'],'Business website':['YOUR BUSINESS','Good work. Real results.','Tell visitors what you do, who you help, and why they should choose your business.','#a33cff','#10152b','What we offer']}[kind];
 if(!data)return {};
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+data[0]+'</title><link rel="stylesheet" href="styles.css"></head><body><nav><b>'+data[0]+'</b><span>HOME　 ABOUT　 CONTACT</span></nav><main><header class="hero"><small>'+data[0]+'</small><h1>'+data[1]+'</h1><p>'+data[2]+'</p><a href="#contact" class="cta">Get in touch</a></header><section><small>01 / WHAT WE DO</small><h2>'+data[5]+'</h2><p>Customize this section with your services, projects, and customer benefits.</p></section><section><small>02 / OUR STORY</small><h2>Built around your goals</h2><p>Tell visitors about your experience, values, and what makes your business different.</p></section><section id="contact"><small>03 / CONTACT</small><h2>Let’s work together</h2><p>Give customers a clear way to reach you and take the next step.</p><a href="mailto:hello@example.com">Contact us</a></section></main><footer>'+data[0]+' · <a href="mailto:hello@example.com">Contact</a></footer><script src="app.js"></script></body></html>';
 const css='*{box-sizing:border-box}body{margin:0;background:'+data[4]+';color:'+(kind==='Agency'?'#f2f1e9':'#20201e')+';font:16px/1.6 system-ui,sans-serif}nav{height:76px;padding:0 8%;display:flex;justify-content:space-between;align-items:center;background:#20201e;color:white}nav b{letter-spacing:2px}nav span{font-size:11px}.hero{min-height:500px;padding:90px 12%;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;background:'+(kind==='Agency'?'linear-gradient(120deg,#17271e,#101712)':kind==='Cafe'?'#ead8c2':'#e5e2d9')+'}.hero small,section small{font-size:10px;letter-spacing:3px;font-weight:800;color:'+data[3]+'}.hero h1{max-width:850px;font:700 clamp(44px,8vw,92px)/.98 Georgia,serif;margin:22px 0}.hero p,section p{max-width:650px;color:#777}.cta{padding:14px 22px;background:'+data[3]+';color:#20201e;text-decoration:none;font-weight:bold}section{padding:55px 12%;border-bottom:1px solid #8884}section h2{font:700 34px Georgia,serif}footer{padding:25px 8%;background:#20201e;color:white}footer a{color:white}@media(max-width:650px){.hero{padding:60px 8%}section{padding:35px 8%}nav{padding:0 5%}}';
 return {_title:data[0],_description:data[2],'index.html':html,'styles.css':css,'app.js':''};
}
function migrateLegacyVisualProjects(){
 let changed=false;
 for(const project of projects){
  const html=project.files&&typeof project.files['index.html']==='string'?project.files['index.html']:'';
  const legacyGeneric=/A NEW WAY FORWARD|Trusted expertise\. Personal service\.|<nav class="nav">✦ Store Website/i.test(html);
  if(project.kind==='Store'&&(!html||legacyGeneric)){
   project.files=storefrontTemplateFiles();project.sections=[];project.title='Everyday things. A little more lovely.';project.description='Thoughtful objects, cheerful colors, and useful things that brighten your day.';project.button='Shop the collection';project.updated=new Date().toISOString();changed=true;
  }else if(['Cafe','Agency','Portfolio','Business website'].includes(project.kind)&&(!html||legacyGeneric)){
   const template=visualTemplateFiles(project.kind);if(template['index.html']){project.files=template;project.updated=new Date().toISOString();changed=true;}
  }
 }
 if(changed){persist();for(const project of projects)if(sessionToken&&accountId!=='guest')syncProject(project);renderProjects();}
}
migrateLegacyVisualProjects();

function createProject(name,kind='Business website'){
 const p={id:id(),name:name.trim(),kind,created:new Date().toISOString(),updated:new Date().toISOString(),title:'Make your idea happen.',description:'A beautiful place to begin. Tell the world what makes your business special.',button:'Get started',accent:'#a33cff',bg:'#10152b',extra:false,sections:[]};
 if(['Cafe','Agency','Portfolio','Business website'].includes(kind)){
  p.files=visualTemplateFiles(kind);p.title=kind==='Cafe'?'Coffee worth slowing down for.':kind==='Agency'?'Make your next move matter.':kind==='Portfolio'?'Ideas made visible.':'Good work. Real results.';p.description=p.files._description;p.button='Get in touch';p.sections=[];p.accent=kind==='Cafe'?'#c87945':kind==='Agency'?'#b7f36b':kind==='Portfolio'?'#ff775e':'#a33cff';p.bg=kind==='Agency'?'#101712':kind==='Cafe'?'#f5eadc':'#f0eee8';
 }else if(kind==='Store'){
  p.title='Everyday things. A little more lovely.';p.description='Thoughtful objects, cheerful colors, and useful things that brighten your day.';p.button='Shop the collection';p.sections=[];p.files=storefrontTemplateFiles();
 }else if(['Booking','Inventory','CRM','Invoice','Support','API','Oracle','Stockroom'].includes(kind)){
  p.kind='Business application · '+kind;p.files=businessTemplateFiles(kind);if(typeof p.files['app.js']==='string')p.files['app.js']=p.files['app.js'].replace('vs-business-demo:'+kind,'vs-business-demo:'+p.id);p.title=p.files._title||kind+' business workspace';p.description=p.files._description||'Open Developer Workspace to customize this business application.';
 }
 projects.unshift(p);activeId=p.id;if(!persist())toast('Browser storage is full. Export your work before leaving.');else syncProject(p);renderProjects();closeModal();openView('editor');toast('Project created. Start customizing your page.')
}
function activeProject(){return projects.find(p=>p.id===activeId)||projects[0]||null}
function duplicateProject(projectId){const source=projects.find(p=>p.id===projectId);if(!source)return;const now=new Date().toISOString();const copy={...source,id:id(),name:source.name+' Copy',created:now,updated:now,cloudSaved:false};projects.unshift(copy);activeId=copy.id;if(!persist()){toast('Could not duplicate: browser storage is full.');return}renderProjects();if(sessionToken&&accountId!=='guest')syncProject(copy);toast('Project duplicated.');}
async function deleteProject(projectId){const project=projects.find(p=>p.id===projectId);if(!project)return;if(!confirm('Delete “'+project.name+'”? This cannot be undone.'))return;try{if(sessionToken&&accountId!=='guest'){const response=await fetch(cloudUrl('/'+encodeURIComponent(project.id)),{method:'DELETE',headers:authHeaders()});if(!response.ok)throw new Error('Cloud delete failed ('+response.status+')')}const ids=deletedIds();ids.add(projectId);if(!saveDeletedIds(ids))throw new Error('Could not record the deletion locally.');projects=projects.filter(p=>p.id!==projectId);if(activeId===projectId)activeId=projects[0]?.id||null;persist();renderProjects();toast('Project deleted from this account.')}catch(error){toast('Could not delete project: '+error.message)}}
const DELETED_KEY='vampiresquid-deleted-projects-v1:'+accountId;
function deletedIds(){try{return new Set(JSON.parse(localStorage.getItem(DELETED_KEY)||'[]'))}catch{return new Set()}}
function saveDeletedIds(ids){try{localStorage.setItem(DELETED_KEY,JSON.stringify(Array.from(ids).slice(-200)));return true}catch{return false}}
const VS_PLUGIN_PACKS={
 'network-inspector':{name:'Network Inspector',version:'1.2.0',description:'Inspect interfaces and routes with configured DNS, Google Public DNS IPs, and Google DNS-over-HTTPS fallback.',entrypoint:'plugins/network-inspector.sh',file:'plugins/network-inspector.sh',source:"#!/bin/sh\n# VampireSquid Network Inspector — configured DNS, Google DNS IPs, then Google DoH.\necho \"=== VAMPIRESQUID NETWORK INSPECTOR ===\"\necho \"--- Interfaces ---\"\nifconfig -a 2>/dev/null || ip addr 2>/dev/null || echo \"No interface inspection command found.\"\necho \"--- Routes ---\"\nroute -n 2>/dev/null || ip route 2>/dev/null || echo \"No route inspection command found.\"\necho \"--- Configured DNS ---\"\ncat /etc/resolv.conf 2>/dev/null || true\nDNS_OK=0\nif command -v nslookup >/dev/null 2>&1; then\n  echo \"--- Trying configured resolver ---\"\n  if nslookup google.com; then DNS_OK=1; echo \"DNS_OK=configured\"; fi\n  if [ \"$DNS_OK\" -eq 0 ]; then\n    echo \"--- Trying Google Public DNS 8.8.8.8 ---\"\n    if nslookup google.com 8.8.8.8; then DNS_OK=1; echo \"DNS_OK=google-8.8.8.8\"; fi\n  fi\n  if [ \"$DNS_OK\" -eq 0 ]; then\n    echo \"--- Trying Google Public DNS 8.8.4.4 ---\"\n    if nslookup google.com 8.8.4.4; then DNS_OK=1; echo \"DNS_OK=google-8.8.4.4\"; fi\n  fi\nelse\n  echo \"nslookup unavailable; skipping DNS-over-UDP checks.\"\nfi\nif [ \"$DNS_OK\" -eq 0 ] && command -v wget >/dev/null 2>&1; then\n  echo \"--- Trying Google DNS over HTTPS ---\"\n  if wget -T 8 -t 1 -qO- 'https://dns.google/resolve?name=google.com&type=A'; then\n    DNS_OK=1\n    echo\n    echo \"DNS_OK=google-doh\"\n  fi\nfi\nif [ \"$DNS_OK\" -eq 0 ]; then echo \"DNS_FAILED=configured,8.8.8.8,8.8.4.4,google-doh\"; fi\necho \"--- External reachability ---\"\nif command -v ping >/dev/null 2>&1; then ping -c 1 1.1.1.1 || ping -c 1 8.8.8.8; else echo \"ping is not installed.\"; fi\n"},
 'dhcp-lab':{name:'DHCP Lab',version:'1.0.0',description:'Inspect DHCP state and manually renew a TinyCore guest lease.',entrypoint:'plugins/dhcp-lab.sh',file:'plugins/dhcp-lab.sh',source:`#!/bin/sh
# VampireSquid DHCP Lab. Default mode is read-only; renew is explicit.
ACTION=$1
[ -n "$ACTION" ] || ACTION=status
IFACE=$2
[ -n "$IFACE" ] || IFACE=eth0
case "$ACTION" in
  status)
    echo "=== VAMPIRESQUID DHCP LAB ==="
    echo "Interface: $IFACE"
    ifconfig "$IFACE" 2>/dev/null || ip addr show "$IFACE" 2>/dev/null || true
    echo "--- Default route ---"
    route -n 2>/dev/null || ip route 2>/dev/null || true
    echo "--- DHCP client ---"
    ps | grep '[u]dhcpc' || echo "No udhcpc process currently visible."
    echo "To request a fresh lease: $0 renew $IFACE"
    ;;
  renew)
    if ! command -v udhcpc >/dev/null 2>&1; then echo "udhcpc is not installed."; exit 127; fi
    echo "Requesting a DHCP lease on $IFACE..."
    if command -v sudo >/dev/null 2>&1; then exec sudo udhcpc -i "$IFACE" -n -q -f; else exec udhcpc -i "$IFACE" -n -q -f; fi
    ;;
  *) echo "Usage: $0 [status|renew] [interface]"; exit 2 ;;
esac
`},
 'oracle-bridge-status':{name:'Oracle Bridge Connector',version:'1.0.0',description:'Read the Oracle executor bridge status through the Cloudflare Worker from TinyCore.',entrypoint:'plugins/oracle-bridge-status.sh',file:'plugins/oracle-bridge-status.sh',source:`#!/bin/sh
# VampireSquid Oracle Bridge Connector — read-only bridge status.
BASE_URL=https://cloudflare-container-networking.brightlambre22-6dd.workers.dev
echo "=== VAMPIRESQUID ORACLE BRIDGE ==="
wget -T 12 -t 1 -qO- "$BASE_URL/api/vm/oracle-status" || exit 1
echo
`},
'android-companion':{name:'Android Companion (Termux)',version:'1.0.0',description:'Android-side device and network diagnostics using Termux and Google DNS over HTTPS.',entrypoint:'plugins/android-companion.sh',file:'plugins/android-companion.sh',source:"#!/data/data/com.termux/files/usr/bin/sh\n# VampireSquid Android Companion — designed for Termux on Android.\necho \"=== VAMPIRESQUID ANDROID COMPANION ===\"\necho \"--- Android build ---\"\ngetprop ro.build.version.release 2>/dev/null || echo \"Android build properties unavailable.\"\necho \"--- Device network ---\"\nip addr 2>/dev/null || ifconfig 2>/dev/null || echo \"Install iproute2 or net-tools in Termux.\"\necho \"--- DNS properties ---\"\ngetprop net.dns1 2>/dev/null\ngetprop net.dns2 2>/dev/null\necho \"--- Google DNS HTTPS resolver ---\"\nif command -v curl >/dev/null 2>&1; then\n  curl -fsS --max-time 8 -H 'accept: application/dns-json' 'https://dns.google/resolve?name=google.com&type=A' || echo \"Google DNS HTTPS query failed.\"\nelse\n  echo \"Install curl in Termux with: pkg install curl\"\nfi\necho \"--- Android environment ---\"\necho \"Termux: $(command -v termux-info 2>/dev/null || echo unavailable)\"\n"},
 'backend-starter':{name:'Backend Starter',version:'1.0.0',description:'Create and serve a tiny editable web application inside TinyCore.',entrypoint:'plugins/backend-starter.sh',file:'plugins/backend-starter.sh',source:`#!/bin/sh
# VampireSquid Backend Starter — creates a local TinyCore web app.
ROOT=$1
[ -n "$ROOT" ] || ROOT=/home/tc/vs-app
mkdir -p "$ROOT" || exit 1
if [ ! -f "$ROOT/index.html" ]; then
  cat > "$ROOT/index.html" <<'HTML'
<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VampireSquid App</title>
<style>body{font:16px system-ui;background:#10152b;color:#f4f6ff;padding:12vh 10vw}h1{font-size:clamp(2rem,7vw,4rem)}p{color:#aab8d4}</style>
<h1>Your VampireSquid app is alive.</h1><p>Built in TinyCore. Customize this file, then prepare it for deployment.</p>
</html>
HTML
fi
if ! command -v busybox >/dev/null 2>&1; then echo "BusyBox is required for the local web server."; exit 127; fi
echo "Serving $ROOT on port 8080. Open http://<TinyCore-IP>:8080"
busybox httpd -p 8080 -h "$ROOT"
`}
};
function stockroomUrl(path=""){return "/api/stockroom"+path+"?account_id="+encodeURIComponent(accountId)}
function setStockroomFormAccess(enabled){
 const form=$("#stockroom-product-form");
 if(form)form.querySelectorAll("input,select,textarea,button").forEach(control=>{control.disabled=!enabled});
}
let stockroomPreviewUrl=null;
function showStockroomImagePreview(src,label){
 const preview=$("#stockroom-image-preview");if(!preview)return;
 if(stockroomPreviewUrl){URL.revokeObjectURL(stockroomPreviewUrl);stockroomPreviewUrl=null;}
 preview.replaceChildren();
 if(src){const image=document.createElement("img");image.src=src;image.alt="Product image preview";image.style.cssText="display:block;width:112px;height:112px;object-fit:cover;border-radius:9px;margin-bottom:7px";preview.append(image);if(src.startsWith("blob:"))stockroomPreviewUrl=src;}
 const caption=document.createElement("span");caption.textContent=label;preview.append(caption);
}
async function initializeStockroomDatabase(){
 const status=$("#stockroom-database-status"),message=$("#stockroom-message");
 if(!sessionToken||!accountId||accountId==="guest"){setStockroomFormAccess(false);if(status)status.textContent="SIGN IN REQUIRED";if(message)message.textContent="Sign in to connect your business Stockroom database before adding, editing, or saving products.";return false}
 setStockroomFormAccess(true);
 if(status)status.textContent="INITIALIZING";
 if(message)message.textContent="Checking your private business database…";
 try{
  const response=await fetch(stockroomUrl("/initialize"),{method:"POST",headers:authHeaders(),body:"{}"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Database initialization failed ("+response.status+")");
  if(status)status.textContent="DATABASE READY";
  if(message)message.textContent="Your account database is ready. Existing product records are preserved.";
  // When TinyCore is reachable, apply the durable online order outbox before
  // displaying stock so the local quantity reflects sales made while offline.
  try {
   const syncResponse=await fetch(stockroomUrl("/sync/orders"),{method:"POST",headers:authHeaders(),body:"{}"});
   const syncData=await syncResponse.json().catch(()=>({}));
   if(syncResponse.ok&&Number(syncData.synchronized)>0&&message)message.textContent=syncData.synchronized+" queued online order(s) synchronized into local Stockroom.";
   else if(!syncResponse.ok&&message)message.textContent="Stockroom is ready. Pending online orders will retry when the TinyCore host is reachable.";
  } catch {
   if(message)message.textContent="Stockroom is ready. Online order synchronization will retry when the host is reachable.";
  }
  await loadStockroomProducts();
  return true;
 }catch(error){
  if(status)status.textContent="DATABASE OFFLINE";
  if(message)message.textContent="Stockroom could not connect: "+error.message;
  return false;
 }
}
async function loadStockroomProducts(){
 const tbody=$("#stockroom-products");
 if(!sessionToken||!accountId||accountId==="guest"){if(tbody)tbody.innerHTML='<tr><td colspan="8">Sign in to load products.</td></tr>';return}
 if(tbody)tbody.innerHTML='<tr><td colspan="8">Loading products…</td></tr>';
 try{
  const query=$("#stockroom-search")?.value.trim()||"";
  const response=await fetch(stockroomUrl("/products")+"&q="+encodeURIComponent(query),{headers:authHeaders()});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Could not load products");
  renderStockroomProducts(data);
 }catch(error){if(tbody)tbody.innerHTML='<tr><td colspan="8">'+escapeHtml(error.message)+'</td></tr>';const message=$("#stockroom-message");if(message)message.textContent="Product loading failed: "+error.message}
}
let editingStockroomProductId=null;
function resetStockroomEditor(){
 const form=$("#stockroom-product-form");if(form)form.reset();
 $("#stockroom-quantity").value="0";$("#stockroom-price").value="0.00";$("#stockroom-cost").value="0.00";$("#stockroom-status").value="active";
 $("#stockroom-image-ref").value="";$("#stockroom-image-file").value="";
 showStockroomImagePreview("","Choose an image from your device. Images are stored securely in R2.");
 editingStockroomProductId=null;
 $("#stockroom-form-title").textContent="Add a product";
 $("#stockroom-form-help").textContent="Create a product record. You can edit it later without leaving Stockroom.";
 $("#stockroom-save").textContent="＋ Save product";
 $("#stockroom-cancel-edit").hidden=true;
}
function renderStockroomProducts(data){
 const products=Array.isArray(data.products)?data.products:[];
 previewStockroomProducts=products;
 if($('#view-editor')?.classList.contains('active')&&activeProject()?.kind==='Store')syncPreview();
 const summary=data.summary||{};
 const count=$("#stockroom-product-count"),units=$("#stockroom-unit-count"),low=$("#stockroom-low-count"),tbody=$("#stockroom-products");
 if(count)count.textContent=Number(summary.product_count||0).toLocaleString();
 if(units)units.textContent=Number(summary.units||0).toLocaleString();
 if(low)low.textContent=Number(summary.low_stock||0).toLocaleString();
 if(!tbody)return;
 if(!products.length){
  tbody.innerHTML='<tr><td colspan="8" style="padding:28px;text-align:center"><strong>Your Stockroom is empty</strong><p class="muted">Add your first product above to start tracking SKUs, prices, and inventory. You can change or archive products at any time.</p><button type="button" class="button button-primary" data-stockroom-empty-add>＋ Add your first product</button></td></tr>';
  return;
 }
 tbody.innerHTML=products.map(p=>{
  const qty=Number(p.quantity||0),stock=qty===0?'<span class="status-chip" style="color:#ff9aa8">Out of stock</span>':qty<=5?'<span class="status-chip" style="color:#ffd18a">Low stock</span>':'<span class="status-chip" style="color:#76e8c5">In stock</span>';
  const status=p.status==='draft'?'Draft':'Active';
  return '<tr><td><b>'+escapeHtml(p.name)+'</b><div class="muted">'+escapeHtml(p.description||"")+'</div></td><td>'+escapeHtml(p.sku)+'</td><td>'+escapeHtml(p.category||"—")+'</td><td>$'+Number(p.price||0).toFixed(2)+'</td><td>$'+Number(p.cost||0).toFixed(2)+'</td><td>'+qty.toLocaleString()+'<div>'+stock+'</div></td><td>'+status+'</td><td><button type="button" class="button button-ghost" data-stockroom-edit="'+escapeHtml(p.id)+'">Edit</button> <button type="button" class="button button-ghost" data-stockroom-delete="'+escapeHtml(p.id)+'">Archive</button></td></tr>';
 }).join("");
}
async function saveStockroomProduct(event){
 event.preventDefault();
 const form=$("#stockroom-product-form"),button=$("#stockroom-save"),message=$("#stockroom-message");
 if(!form||!sessionToken||!accountId||accountId==="guest"){setStockroomFormAccess(false);if(message)message.textContent="Sign in before saving products.";return}
 let variations=[];try{variations=JSON.parse($("#stockroom-variations").value.trim()||"[]");if(!Array.isArray(variations))throw new Error("Variations must be a JSON array.")}catch(error){if(message)message.textContent=error.message||"Variations must be valid JSON.";return}
 const payload={
  name:$("#stockroom-name").value.trim(),sku:$("#stockroom-sku").value.trim(),
  category:$("#stockroom-category").value.trim(),quantity:Number($("#stockroom-quantity").value),
  price:Number($("#stockroom-price").value),cost:Number($("#stockroom-cost").value),
  image_url:$("#stockroom-image-ref").value.trim(),external_url:$("#stockroom-external-url").value.trim(),
  description:$("#stockroom-description").value.trim(),status:$("#stockroom-status").value,variations
 };
 const editing=Boolean(editingStockroomProductId),existingId=editingStockroomProductId;
 button.disabled=true;button.textContent=editing?"Saving changes…":"Saving…";
 try{
  let savedId=existingId;
  if(!editing){
   const createResponse=await fetch(stockroomUrl("/products"),{method:"POST",headers:authHeaders(),body:JSON.stringify(payload)});
   const created=await createResponse.json().catch(()=>({}));
   if(!createResponse.ok)throw new Error(created.error==="sku_already_exists"?"That SKU is already in your Stockroom.":created.error||"Product could not be saved");
   savedId=created.product?.id;
   if(typeof savedId!=="string")throw new Error("Product was saved but the server did not return its product ID.");
   editingStockroomProductId=savedId;
  }
  const file=$("#stockroom-image-file")?.files?.[0];
  if(file){
   if(!savedId)throw new Error("Save the product before uploading its image.");
   const upload=new FormData();upload.append("image",file,file.name);
   const uploadResponse=await fetch(stockroomUrl("/media/"+encodeURIComponent(savedId)),{method:"POST",headers:{authorization:authHeaders().authorization},body:upload});
   const media=await uploadResponse.json().catch(()=>({}));
   if(!uploadResponse.ok)throw new Error("Product saved, but image upload failed: "+(media.error||"R2 upload failed"));
   payload.image_url=media.image_url;
  }
  if(editing||file){
   const updateResponse=await fetch(stockroomUrl("/products/"+encodeURIComponent(savedId)),{method:"PUT",headers:authHeaders(),body:JSON.stringify(payload)});
   const updated=await updateResponse.json().catch(()=>({}));
   if(!updateResponse.ok)throw new Error("Product saved, but its final update failed: "+(updated.error||"update failed"));
  }
  if(message)message.textContent=payload.name+(editing?" was updated.":" was saved to Stockroom.")+(file?" Product image uploaded to R2 and attached.":"");
  resetStockroomEditor();await loadStockroomProducts();
 }catch(error){if(message)message.textContent="Save failed: "+error.message;await loadStockroomProducts()}
 finally{button.disabled=false;button.textContent=editingStockroomProductId?"Save changes":"＋ Save product"}
}
async function editStockroomProduct(productId){
 try{
  const response=await fetch(stockroomUrl("/products"),{headers:authHeaders()});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Could not load product");
  const product=(data.products||[]).find(item=>item.id===productId);
  if(!product)throw new Error("Product was not found.");
  editingStockroomProductId=productId;
  $("#stockroom-name").value=product.name||"";$("#stockroom-sku").value=product.sku||"";
  $("#stockroom-category").value=product.category||"";$("#stockroom-quantity").value=product.quantity??0;
  $("#stockroom-price").value=Number(product.price||0).toFixed(2);$("#stockroom-cost").value=Number(product.cost||0).toFixed(2);
  $("#stockroom-image-ref").value=product.image_url||"";$("#stockroom-image-file").value="";
  showStockroomImagePreview(product.image_url||"",product.image_url?"Current product image. Choose a new file to replace it.":"No product image uploaded yet.");
  $("#stockroom-external-url").value=product.external_url||"";
  $("#stockroom-description").value=product.description||"";$("#stockroom-variations").value=JSON.stringify(product.variations||[],null,2);
  $("#stockroom-status").value=product.status==="draft"?"draft":"active";
  $("#stockroom-form-title").textContent="Edit product";
  $("#stockroom-form-help").textContent="Update the fields below, then save your changes.";
  $("#stockroom-save").textContent="Save changes";$("#stockroom-cancel-edit").hidden=false;
  $("#stockroom-product-form").scrollIntoView({behavior:"smooth",block:"center"});
  $("#stockroom-name").focus();
 }catch(error){$("#stockroom-message").textContent="Could not open product: "+error.message}
}
async function archiveStockroomProduct(productId){
 if(!confirm("Archive this product? It will no longer appear in the active product list."))return;
 try{
  const response=await fetch(stockroomUrl("/products/"+encodeURIComponent(productId)),{method:"DELETE",headers:authHeaders()});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||"Archive failed");
  $("#stockroom-message").textContent="Product archived.";await loadStockroomProducts();
 }catch(error){$("#stockroom-message").textContent="Archive failed: "+error.message}
}
function renderStockroom(){void initializeStockroomDatabase()}
function businessTemplateFiles(kind){
 const specs={
  Booking:{title:'Appointment Desk',subtitle:'Manage appointments and customer requests',columns:['Customer','Service','Date','Status'],rows:[['Jordan Lee','Consultation','Today, 10:30 AM','Confirmed'],['Taylor Morgan','Follow-up','Today, 1:00 PM','Pending'],['Alex Rivera','New booking','Tomorrow, 9:00 AM','Confirmed']],action:'New appointment',note:'Connect your booking API or webhook to synchronize real appointments.'},
  Inventory:{title:'Inventory Control',subtitle:'Track stock levels and incoming orders',columns:['Item','SKU','Stock','Status'],rows:[['Coffee beans','CF-001','42','In stock'],['Paper cups','PC-014','8','Low stock'],['Gift cards','GC-003','120','In stock']],action:'Add inventory item',note:'Connect your inventory API to synchronize live stock and order data.'},
  CRM:{title:'Customer Pipeline',subtitle:'Track leads, conversations, and follow-ups',columns:['Contact','Company','Stage','Next step'],rows:[['Jamie Chen','Northstar Co.','Qualified','Schedule demo'],['Morgan Davis','Fieldworks','New lead','Send introduction'],['Sam Patel','Brightside','Proposal','Follow up']],action:'Add contact',note:'Connect your CRM API or webhook to synchronize customer records.'},
  Invoice:{title:'Invoice Manager',subtitle:'Monitor invoices and payment status',columns:['Invoice','Customer','Amount','Status'],rows:[['INV-1001','Jordan Lee','$450.00','Paid'],['INV-1002','Northstar Co.','$1,200.00','Pending'],['INV-1003','Taylor Morgan','$275.00','Overdue']],action:'Create invoice',note:'Connect a payment provider and a server-side invoice API before accepting real payments.'},
  Support:{title:'Support Desk',subtitle:'Organize customer requests and service tickets',columns:['Ticket','Customer','Priority','Status'],rows:[['#2041','Jordan Lee','Normal','Open'],['#2042','Taylor Morgan','High','In progress'],['#2043','Alex Rivera','Low','Resolved']],action:'Create ticket',note:'Connect your support API or webhook to receive and update real tickets.'},
  API:{title:'API Operations',subtitle:'Monitor endpoints and inspect service health',columns:['Service','Endpoint','Last check','Status'],rows:[['Public API','/health','Just now','Healthy'],['Customer API','/api/customers','Not checked','Not checked'],['Webhook','/hooks/events','Not checked','Not checked']],action:'Add endpoint',note:'Use the VampireSquid Network Center to test DNS, HTTPS, and API reachability. Browser requests may be subject to CORS.'},
  Oracle:{title:'Business Network Hub',subtitle:'TinyCore guest networking and Oracle bridge monitor',columns:['Component','Role','Connection','Status'],rows:[['TinyCore','Linux guest','wget / HTTPS','Ready to test'],['Cloudflare','Edge gateway','Worker API','Connected'],['Oracle','Execution bridge','Status endpoint','Check live']],action:'Add service',note:'Install the included TinyCore shell plugin to check Oracle bridge status from inside the guest.'},
  Stockroom:{title:'Stockroom',subtitle:'Business products and inventory',columns:['Product','SKU','Quantity','Status'],rows:[],action:'Add product',note:'The live Stockroom interface connects to the account database; this project template is a visual starter.'}
 };
 const spec=specs[kind];if(!spec)return {};
 const html='<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>'+spec.title+'</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n<header><div><span class="eyebrow">VAMPIRESQUID BUSINESS TOOLS</span><h1>'+spec.title+'</h1><p>'+spec.subtitle+'</p></div><button id="add-record">'+spec.action+'</button></header>\n<main><section class="summary"><article><small>RECORDS</small><strong id="record-count">'+spec.rows.length+'</strong></article><article><small>WORKSPACE</small><strong>Demo data</strong></article><article><small>NETWORK</small><strong id="network-state">Not connected</strong></article></section><section class="panel"><div class="panel-head"><h2>Recent activity</h2><span>Sample records · edit to customize</span></div><div class="table-wrap"><table><thead><tr>'+spec.columns.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody id="records">'+spec.rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></section><section class="panel integration"><h2>Connect your services</h2><p>'+spec.note+'</p><label for="api-endpoint">API health endpoint</label><div class="connect-row"><input id="api-endpoint" type="url" placeholder="https://api.example.com/health"><button id="test-api">Test endpoint</button></div><pre id="api-result">No endpoint tested. Use Network Center for guest-side DNS and HTTPS diagnostics.</pre></section></main><script src="app.js"></script>\n</body>\n</html>';
 const css='*{box-sizing:border-box}body{margin:0;padding:36px;background:#0b1224;color:#eef3ff;font:15px/1.5 system-ui,sans-serif}header{display:flex;justify-content:space-between;align-items:center;gap:20px;max-width:1100px;margin:0 auto 28px}h1{font-size:clamp(28px,5vw,42px);margin:8px 0}header p,.panel p{color:#a9b7d2}.eyebrow,small{color:#69dced;letter-spacing:1.5px;font-size:10px;font-weight:800}button{border:0;border-radius:8px;padding:12px 16px;background:#8147e8;color:white;font-weight:700;cursor:pointer}.summary{max-width:1100px;margin:0 auto 18px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.summary article,.panel{background:#121d35;border:1px solid #2a3a5e;border-radius:12px;padding:18px}.summary strong{display:block;font-size:22px;margin-top:8px}.panel{max-width:1100px;margin:0 auto 16px}.panel-head,.connect-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.panel h2{font-size:16px;margin:0 0 12px}.panel-head span{color:#8798b8;font-size:11px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:13px;border-bottom:1px solid #273653;font-size:12px}th{color:#91a4c8;font-size:10px;text-transform:uppercase}label{display:block;margin:14px 0 7px;color:#a9b7d2;font-size:11px}input{flex:1;min-width:0;background:#091020;color:white;border:1px solid #35476b;border-radius:8px;padding:12px}.integration pre{white-space:pre-wrap;color:#9fe9db;background:#080f1d;border-radius:8px;padding:12px;min-height:42px}@media(max-width:650px){body{padding:20px}header{align-items:flex-start;flex-direction:column}.summary{grid-template-columns:1fr}.connect-row{align-items:stretch;flex-direction:column}}';
 const js="const key='vs-business-demo:"+kind+"';const columns="+JSON.stringify(spec.columns)+";const body=document.querySelector('#records'),count=document.querySelector('#record-count');function save(){try{localStorage.setItem(key,body.innerHTML)}catch(e){document.querySelector('#api-result').textContent='Browser storage is full; export this project to keep a copy.'}}function addActions(){Array.from(body.rows).forEach(row=>{if(row.querySelector('[data-edit]'))return;const cell=document.createElement('td');cell.innerHTML='<button type=\"button\" data-edit>Edit</button> <button type=\"button\" data-remove>Delete</button>';row.append(cell)})}try{const saved=localStorage.getItem(key);if(saved)body.innerHTML=saved}catch(e){}addActions();count.textContent=body.rows.length;document.querySelector('#add-record').addEventListener('click',()=>{const values=[];for(let i=0;i<columns.length;i++){const value=prompt('Enter '+columns[i]+':',i===0?'':'');if(value===null)return;values.push(value)}const row=document.createElement('tr');values.forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell)});body.prepend(row);addActions();count.textContent=body.rows.length;save()});body.addEventListener('click',event=>{const row=event.target.closest('tr');if(!row)return;if(event.target.closest('[data-remove]')){if(confirm('Delete this record?')){row.remove();count.textContent=body.rows.length;save()}return}if(event.target.closest('[data-edit]')){const cells=Array.from(row.cells).slice(0,-1);for(let i=0;i<cells.length;i++){const value=prompt('Edit '+columns[i]+':',cells[i].textContent);if(value===null)return;cells[i].textContent=value}save()}});document.querySelector('#test-api').addEventListener('click',async()=>{const url=document.querySelector('#api-endpoint').value.trim(),out=document.querySelector('#api-result'),state=document.querySelector('#network-state');let parsed;try{parsed=new URL(url)}catch{out.textContent='Enter a valid endpoint URL.';return}if(!['https:','http:'].includes(parsed.protocol)){out.textContent='Only HTTP and HTTPS endpoints are supported.';return}out.textContent='Testing endpoint…';try{const response=await fetch(parsed.href,{method:'GET',mode:'cors',credentials:'omit',signal:AbortSignal.timeout(8000)});out.textContent='HTTP '+response.status+' '+response.statusText+'\\n'+(await response.text()).slice(0,3000);state.textContent=response.ok?'Reachable':'HTTP '+response.status}catch(error){out.textContent='Browser request failed: '+error.message+'\\nUse VampireSquid Network Center for guest-side connectivity checks; CORS may block browser inspection.';state.textContent='Not verified'}});";
 const readme='# '+spec.title+'\n\nThis is a starter business-tool interface with sample data. In VampireSquid Studio, records are saved with this account\'s cloud project. Standalone HTML exports use browser storage on that device.\n\n## Connect real data\n- Implement authenticated API routes in your VampireSquid backend.\n- Keep secrets on the server; do not place API keys in browser JavaScript.\n- Use Network Center guest diagnostics to check DNS, HTTPS, and endpoint reachability.\n- Browser API calls require the target service to allow CORS. For private integrations, route requests through an authenticated, account-scoped backend endpoint with SSRF protections.\n\n## Files\n- index.html: dashboard interface\n- styles.css: responsive styling\n- app.js: demo interactions and endpoint reachability check\n';
 if(kind==='Stockroom'){return {_title:spec.title,_description:spec.subtitle,'index.html':html,'styles.css':css,'app.js':js,'README.md':readme+'\n\n## Stockroom\nThis is a starter preview only. The live Stockroom view in Studio connects to the account-scoped SQLite business database for product and inventory records.\n'};}if(kind==='Oracle'){const plugin='#!/bin/sh\nBASE_URL=https://cloudflare-container-networking.brightlambre22-6dd.workers.dev\nwget -T 12 -t 1 -qO- "$BASE_URL/api/vm/oracle-status" || exit 1\n';const manifest=JSON.stringify({name:'oracle-bridge-status',version:'1.0.0',runtime:'TinyCore Linux',entrypoint:'plugins/oracle-bridge-check.sh',description:'Checks Oracle bridge status from inside TinyCore.'},null,2);return {_title:spec.title,_description:spec.subtitle,'index.html':html,'styles.css':css,'app.js':js,'README.md':readme+'\n\n## TinyCore plugin\nCopy plugins/oracle-bridge-check.sh into /home/tc, run chmod +x, then execute it. It uses wget from TinyCore to check Oracle bridge status through Cloudflare. No account secrets are embedded.\n','plugin.json':manifest,'plugins/oracle-bridge-check.sh':plugin};}return {_title:spec.title,_description:spec.subtitle,'index.html':html,'styles.css':css,'app.js':js,'README.md':readme};
}
function previewDoc(p,includeStockroomPreview=true){
 const files=p.files&&typeof p.files==='object'?p.files:{};
 if(typeof files['index.html']==='string'){
  let doc=files['index.html'];
  if(p.kind==='Store'){
   doc=doc.replace(/Continue to secure PayPal checkout/g,'Continue to secure checkout');
   doc=doc.replace(/Live checkout is available after publishing and connecting PayPal\\./g,'Checkout methods appear here after the merchant enables PayPal or Base USDC.');
  }
  const title=escapeHtml(p.title||files._title||'Your business');
  const description=escapeHtml(p.description||files._description||'');
  if(includeStockroomPreview&&p.kind==='Store'){
   const previewProducts=previewStockroomProducts.filter(product=>product.status==='active').map(product=>({id:product.id,sku:product.sku,name:product.name,description:product.description,category:product.category,image_url:product.image_url,price:Number(product.price||0),in_stock:Number(product.quantity||0)>0,variations:product.variations||[]}));
   const previewScript='<script>window.__VAMPIRESQUID_PREVIEW_PRODUCTS__='+JSON.stringify(previewProducts).replace(/</g,'\\u003c')+'</script>';
   doc=doc.replace('</head>',previewScript+'</head>');
  }
  doc=doc.replace(/<title>[\s\S]*?<\/title>/i,'<title>'+title+'</title>');
  doc=doc.replace(/(<h1[^>]*>)[\s\S]*?(<\/h1>)/i,'$1'+title+'$2');
  doc=doc.replace(/(<header[^>]*>[\s\S]*?<p[^>]*>)[\s\S]*?(<\/p>)/i,'$1'+description+'$2');
  if(typeof files['styles.css']==='string')doc=doc.replace(/<link[^>]+href=["']styles\.css["'][^>]*>/i,'<style>'+files['styles.css']+'</style>');
  const previewSeed=p.data&&p.data.previewStorage&&typeof p.data.previewStorage==='object'?p.data.previewStorage:(()=>{try{const legacy=localStorage.getItem('vs-business-demo:'+p.id);return legacy?{['vs-business-demo:'+p.id]:legacy}:{}}catch{return {}}})();
  const previewBridge='<script>(function(){var projectId='+JSON.stringify(p.id)+';var values='+JSON.stringify(previewSeed)+';var nativeStore=null;try{nativeStore=window.localStorage}catch(e){}if(window.parent===window&&nativeStore)return;function persist(){if(window.parent!==window){window.parent.postMessage({type:"vs-preview-storage-write",projectId:projectId,value:values},"*")}else if(nativeStore){try{nativeStore.clear();Object.keys(values).forEach(function(key){nativeStore.setItem(key,values[key])})}catch(e){}}}var storage={getItem:function(key){return Object.prototype.hasOwnProperty.call(values,key)?String(values[key]):null},setItem:function(key,value){values[String(key)]=String(value);persist()},removeItem:function(key){delete values[String(key)];persist()},clear:function(){values={};persist()},key:function(index){return Object.keys(values)[index]||null}};Object.defineProperty(storage,"length",{get:function(){return Object.keys(values).length}});try{Object.defineProperty(window,"localStorage",{value:storage,configurable:false})}catch(e){}})();<\/script>';
  if(typeof files['app.js']==='string'){
   const appSource=p.kind==='Store'?files['app.js'].replace(/Creating secure PayPal checkout…/g,'Preparing secure checkout with the merchant’s enabled payment methods…'):files['app.js'];
   doc=doc.replace(/<script[^>]+src=["']app\.js["'][^>]*><\/script>/i,()=>previewBridge+'<script>'+appSource+'</script>');
  }
  const extraSections=(Array.isArray(p.sections)?p.sections:[]).map(section=>'<section class="vs-studio-section"><small>'+escapeHtml(section.type||'SECTION')+'</small><h2>'+escapeHtml(section.title||'')+'</h2><p>'+escapeHtml(section.body||'')+'</p></section>').join('');
  if(extraSections){doc=doc.replace('</head>','<style>.vs-studio-section{max-width:1100px;margin:18px auto;padding:24px;border:1px solid #ffffff22;border-radius:12px;background:#121d35;color:#eef3ff}.vs-studio-section small{color:#69dced;text-transform:uppercase;letter-spacing:1px}.vs-studio-section p{color:#a9b7d2;white-space:pre-wrap}</style></head>');doc=doc.replace('</main>',extraSections+'</main>')}
  // Keep user-supplied and template HTML usable on narrow screens.
  if(!doc.toLowerCase().includes('name="viewport"')&&!doc.toLowerCase().includes("name='viewport'")){
   doc=doc.replace(/<head([^>]*)>/i,'<head$1><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  }
  const responsiveCss='*,*::before,*::after{box-sizing:border-box}html{width:100%;max-width:100%;overflow-x:hidden;-webkit-text-size-adjust:100%}body{min-width:0;max-width:100%;overflow-x:hidden;overflow-wrap:anywhere}img,picture,video,canvas,svg{max-width:100%}img,video{height:auto}iframe{max-width:100%}main,header,footer,section,article,aside{min-width:0}pre{max-width:100%;overflow-x:auto}table{max-width:100%;display:block;overflow-x:auto}input,select,textarea,button{max-width:100%;font:inherit}input,select,textarea{min-width:0}button,a{touch-action:manipulation}@media(max-width:640px){body{font-size:16px}h1,h2,h3,p{overflow-wrap:anywhere}input,select,textarea,button{min-height:40px}nav{max-width:100%;flex-wrap:wrap}img,video{object-fit:contain}}';
  const headEnd=doc.toLowerCase().lastIndexOf('</head>');if(headEnd>=0)doc=doc.slice(0,headEnd)+'<style id="vs-responsive-compat">'+responsiveCss+'</style>'+doc.slice(headEnd);
  return doc;
 }
 const accent=/^#[0-9a-f]{6}$/i.test(p.accent||'')?p.accent:'#a33cff',background=/^#[0-9a-f]{6}$/i.test(p.bg||'')?p.bg:'#10152b',title=escapeHtml(p.title||'Your headline'),desc=escapeHtml(p.description||''),button=escapeHtml(p.button||'Learn more'),sections=Array.isArray(p.sections)?p.sections:[];
 const sectionHtml=sections.map(section=>{const heading=escapeHtml(section.title||''),body=escapeHtml(section.body||'');if(section.type==='features')return '<section class="content-section features"><div class="section-inner"><span class="eyebrow">WHAT WE OFFER</span><h2>'+heading+'</h2><p>'+body+'</p><div class="tiles"><article class="tile"><b>Thoughtful approach</b><p>Carefully considered from the first idea to the final detail.</p></article><article class="tile"><b>Made for you</b><p>Flexible solutions shaped around your goals.</p></article><article class="tile"><b>Built to grow</b><p>A strong foundation for whatever comes next.</p></article></div></div></section>';if(section.type==='about')return '<section class="content-section about"><div class="section-inner"><span class="eyebrow">OUR STORY</span><h2>'+heading+'</h2><p>'+body+'</p></div></section>';return '<section class="content-section contact" id="contact"><div class="section-inner"><span class="eyebrow">GET IN TOUCH</span><h2>'+heading+'</h2><p>'+body+'</p><a class="cta" href="mailto:hello@example.com">Contact us</a></div></section>'}).join('');
 return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:'+background+';color:#fff;font:16px/1.65 Arial,sans-serif}.nav{min-height:68px;padding:0 7%;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff22;font-weight:bold;letter-spacing:2px}.nav span{font-size:12px;color:#b7c0d6;font-weight:normal;letter-spacing:0}.hero{min-height:430px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:70px 12%;background:radial-gradient(ellipse at 80% 30%,'+accent+'55,transparent 50%)}.eyebrow{font-size:11px;letter-spacing:3px;color:'+accent+';font-weight:bold}.hero h1{font-size:clamp(38px,7vw,72px);line-height:1.04;max-width:800px;margin:20px 0}.hero p,.content-section p{color:#c4cbe0;max-width:650px;font-size:16px}.cta{display:inline-block;margin-top:18px;background:'+accent+';color:white;text-decoration:none;padding:13px 22px;border-radius:7px;font-weight:bold}.content-section{padding:70px 12%}.content-section h2{font-size:clamp(27px,4vw,42px);line-height:1.12;margin:14px 0}.features{background:#ffffff08}.section-inner{max-width:1100px;margin:auto}.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:26px}.tile{padding:22px;border:1px solid #ffffff22;border-radius:10px;color:#fff}.tile p{font-size:13px;margin-bottom:0}.about{background:#ffffff05}.contact{text-align:center;background:linear-gradient(120deg,'+accent+'22,transparent)}.contact p{margin:0 auto}.contact .cta{margin-top:22px}@media(max-width:600px){.tiles{grid-template-columns:1fr}.hero{padding:55px 8%;min-height:380px}.content-section{padding:55px 8%}.nav{padding:0 8%}.nav span{font-size:10px}}</style></head><body><nav class="nav">✦ '+escapeHtml(p.name||'YOUR BRAND')+' <span>HOME　 ABOUT　 CONTACT</span></nav><main><section class="hero"><div class="eyebrow">A NEW WAY FORWARD</div><h1>'+title+'</h1><p>'+desc+'</p><a class="cta" href="#contact">'+button+'</a></section>'+sectionHtml+'</main></body></html>';
}
function renderSectionList(){const p=activeProject(),list=$('#section-list');if(!list)return;const sections=Array.isArray(p?.sections)?p.sections:[];list.innerHTML=sections.map(section=>'<button type="button" class="section-item '+(section.id===selectedSectionId?'active':'')+'" data-select-section="'+escapeHtml(section.id)+'"><span>'+escapeHtml(section.type.charAt(0).toUpperCase()+section.type.slice(1))+'</span><b>'+escapeHtml(section.title||'Untitled section')+'</b></button>').join('')||'<p class="section-empty">Add a section to build out your page.</p>';const current=sections.find(x=>x.id===selectedSectionId),fields=$('#section-fields');if(fields){fields.hidden=!current;if(current){$('#section-title').value=current.title||'';$('#section-body').value=current.body||''}}}
function addSection(type){const p=activeProject();if(!p)return;const defaults={features:{title:'What makes us different',body:'Share the value you bring and what makes your work special.'},about:{title:'A little about us',body:'Tell visitors your story, what you believe, and why you do what you do.'},contact:{title:'Let’s talk',body:'Have a question or a project in mind? We would love to hear from you.'}};p.sections=Array.isArray(p.sections)?p.sections:[];const section={id:id(),type,...defaults[type]};p.sections.push(section);selectedSectionId=section.id;renderSectionList();syncPreview()}
function syncPreview(){const p=activeProject();if(!p)return;p.title=$('#site-title').value;p.description=$('#site-description').value;p.button=$('#site-button').value;p.accent=$('#site-color').value;p.bg=$('#site-bg').value;const selected=(p.sections||[]).find(x=>x.id===selectedSectionId);if(selected){selected.title=$('#section-title').value;selected.body=$('#section-body').value;const item=$('#section-list [data-select-section="'+selectedSectionId+'"] b');if(item)item.textContent=selected.title||'Untitled section'}const frame=$('#site-canvas');if(frame)frame.srcdoc=previewDoc(p)}
function loadEditor(){const p=activeProject();if(!p)return;activeId=p.id;p.sections=Array.isArray(p.sections)?p.sections:[];$('#editor-project').value=p.id;$('#site-title').value=p.title;$('#site-description').value=p.description;$('#site-button').value=p.button;$('#site-color').value=p.accent;$('#site-bg').value=p.bg;selectedSectionId=p.sections[0]?.id||null;renderSectionList();syncPreview();if(p.kind==='Store'&&sessionToken&&accountId!=='guest')void loadStockroomProducts()}
function saveEditor(){const p=activeProject();if(!p){toast('Create a project first.');return}p.title=$('#site-title').value;p.description=$('#site-description').value;p.button=$('#site-button').value;p.accent=$('#site-color').value;p.bg=$('#site-bg').value;p.updated=new Date().toISOString();if(!persist()){toast('Could not save: browser storage is full.');return}renderProjects();syncPreview();if(sessionToken&&accountId!=='guest')syncProject(p).then(ok=>toast(ok?'Project saved to VampireSquid cloud storage.':'Draft saved locally; cloud sync needs attention.'));else toast('Draft saved in this browser.')}
function download(){const p=activeProject();if(!p){toast('Create a project first.');return}const blob=new Blob([previewDoc(p)],{type:'text/html'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(p.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'vampiresquid-site')+'.html';a.click();URL.revokeObjectURL(url);toast('HTML export downloaded.')}

let paypalConnection={connected:false,mode:null,client_id:null};
async function loadPaymentSettings(){
 const status=$('#payment-paypal-status'),cryptoStatus=$('#payment-crypto-status');
 if(!sessionToken||accountId==='guest'){if(status)status.textContent='Sign in to connect merchant payment accounts.';return}
 try{
  const mode=$('#payment-paypal-mode')?.value||'sandbox';
  const q='?account_id='+encodeURIComponent(accountId),headers=authHeaders();
  const [settingsResponse,paypalResponse]=await Promise.all([fetch('/api/payments/settings'+q,{headers}),fetch('/api/payments/paypal/status'+q+'&mode='+encodeURIComponent(mode),{headers})]);
  const settings=await settingsResponse.json(),paypal=await paypalResponse.json();
  if(!settingsResponse.ok)throw new Error(settings.error||'Could not load payment settings');
  if(!paypalResponse.ok)throw new Error(paypal.error||'Could not load PayPal connection');
  if(paypal.connected){
   const activate=await fetch('/api/payments/paypal/connect'+q,{method:'POST',headers,body:JSON.stringify({mode})});
   const activated=await activate.json();if(!activate.ok)throw new Error(activated.error||'Could not activate selected PayPal environment');
  }
  paypalConnection=paypal;
  $('#payment-wallet').value=settings.settings?.wallet_address||'';
  $('#payment-crypto-enabled').checked=!!settings.settings?.crypto_enabled;
  $('#payment-paypal-client').value=paypal.client_id||'';
  $('#payment-paypal-secret').value='';
  const modes=paypal.available_modes||{};
  status.textContent=paypal.connected?'PayPal '+mode.toUpperCase()+' connected · Sandbox '+(modes.sandbox?'ready':'not connected')+' · Live '+(modes.live?'ready':'not connected'):'No '+mode.toUpperCase()+' app connected. Enter its Client ID and Secret.';
  $('#payment-paypal-connect').textContent=paypal.connected?'Update '+mode.toUpperCase()+' app':'Connect '+mode.toUpperCase()+' app';
  if(cryptoStatus)cryptoStatus.textContent='Payment settings loaded.';
 }catch(error){if(status)status.textContent=error.message}
}
async function connectPaypal(){
 const status=$('#payment-paypal-status'),button=$('#payment-paypal-connect');
 const clientId=$('#payment-paypal-client').value.trim(),secret=$('#payment-paypal-secret').value.trim(),mode=$('#payment-paypal-mode').value;
 if(!clientId||!secret){status.textContent='Enter both your PayPal Client ID and Secret.';return}
 button.disabled=true;status.textContent='Validating '+mode.toUpperCase()+' credentials with PayPal and saving encrypted connection…';
 try{
  const r=await fetch('/api/payments/paypal/connect?account_id='+encodeURIComponent(accountId),{method:'PUT',headers:authHeaders(),body:JSON.stringify({client_id:clientId,client_secret:secret,mode})});
  const d=await r.json();if(!r.ok)throw new Error(d.error||'PayPal connection failed');
  $('#payment-paypal-secret').value='';paypalConnection={connected:true,mode:d.mode,client_id:d.client_id};
  status.textContent='PayPal '+mode.toUpperCase()+' REST app validated and connected. Credentials are encrypted.';
  await loadPaymentSettings();
 }catch(error){status.textContent=error.message}
 finally{button.disabled=false}
}
async function disconnectPaypal(){
 const status=$('#payment-paypal-status');if(!confirm('Disconnect this PayPal REST app from your VampireSquid store?'))return;
 try{const r=await fetch('/api/payments/paypal/connect?account_id='+encodeURIComponent(accountId),{method:'DELETE',headers:authHeaders()});const d=await r.json();if(!r.ok)throw new Error(d.error||'Disconnect failed');paypalConnection={connected:false};$('#payment-paypal-client').value='';$('#payment-paypal-secret').value='';status.textContent='PayPal REST app disconnected.';$('#payment-paypal-connect').textContent='Connect PayPal app'}
 catch(error){status.textContent=error.message}
}
async function saveCryptoSettings(){
 const status=$('#payment-crypto-status'),button=$('#payment-save-crypto');button.disabled=true;status.textContent='Saving…';
 const modes=paypalConnection.available_modes||{};
 try{const body={wallet_address:$('#payment-wallet').value.trim(),paypal_url:'',crypto_enabled:$('#payment-crypto-enabled').checked,paypal_enabled:Boolean(paypalConnection.connected||modes.sandbox||modes.live)};
  const r=await fetch('/api/payments/settings?account_id='+encodeURIComponent(accountId),{method:'PUT',headers:authHeaders(),body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not save payment settings');
  status.textContent='Payment settings saved.';
 }catch(error){status.textContent=error.message}finally{button.disabled=false}
}


function safePublishedUrl(value){
 if(typeof value!=='string'||!value)return '';
 try{const parsed=new URL(value,location.origin),parts=parsed.pathname.split('/'),slug=parts[2]||'',valid=slug.length===32&&Array.from(slug).every(ch=>'0123456789abcdef'.includes(ch));if(parsed.origin!==location.origin||parts.length!==4||parts[0]!==''||parts[1]!=='sites'||!valid||parts[3]!==''||parsed.search||parsed.hash)return '';return parsed.href}catch{return ''}
}
function updateViewWebsite(project){
 const link=$('#view-website');if(!link)return;
 const url=safePublishedUrl(project&&project.publishedUrl);
 link.href=url||'#';link.setAttribute('aria-disabled',url?'false':'true');
 link.title=url?'Open the selected published website':'Publish this project to make it available';
}
function updatePublishedAddress(project){
 const holder=$('#published-address');if(!holder)return;
 const url=safePublishedUrl(project&&project.publishedUrl);
 holder.textContent='';
 if(!url){holder.textContent='Not published yet';return}
 const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=url;holder.appendChild(link);
}
function loadPublishOptions(){
 const select=$('#publish-project');if(!select)return;
 select.innerHTML=projects.map(p=>'<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</option>').join('')||'<option value="">Create a project first</option>';
 const current=projects.find(p=>p.id===activeId)||projects[0];
 if(current){select.value=current.id;updatePublishedAddress(current);updateViewWebsite(current)}else{updatePublishedAddress(null);updateViewWebsite(null)}
}
async function publishProject(){
 const status=$('#publish-status'),button=$('#publish-site'),project=projects.find(p=>p.id===$('#publish-project').value);
 if(!project){status.textContent='Create a project first.';return}
 if(!sessionToken||accountId==='guest'){status.textContent='Sign in to publish a website.';return}
 if(project.id===activeId)syncPreview();
 status.textContent='Saving the latest project and publishing to Cloudflare…';button.disabled=true;
 try{
  const saved=await syncProject(project);
  if(!saved)throw new Error('The latest project could not be saved to your account. Publishing was stopped to prevent an outdated version going live.');
  const html=previewDoc(project,false);
  const response=await fetch('/api/studio/publish?account_id='+encodeURIComponent(accountId),{method:'POST',headers:authHeaders(),body:JSON.stringify({project_id:project.id,html})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'Publishing failed');
  const publishedUrl=safePublishedUrl(data.url);
  if(!publishedUrl)throw new Error('The server returned an invalid published website address.');
  project.publishedUrl=publishedUrl;project.publishedAt=data.published_at;project.updated=new Date().toISOString();
  if(!persist())throw new Error('The site is published, but its link could not be saved in this browser.');
  await syncProject(project);
  updatePublishedAddress(project);updateViewWebsite(project);
  status.textContent='Published successfully. Your site is served by Cloudflare and remains online without TinyCore.';
  renderProjects();
 }catch(error){status.textContent='Publish failed: '+error.message}
 finally{button.disabled=false}
}

function bind(){ $('#publish-site')?.addEventListener('click',publishProject);$('#publish-project')?.addEventListener('change',()=>{const p=projects.find(x=>x.id===$('#publish-project').value);updatePublishedAddress(p);updateViewWebsite(p)});$('#view-website')?.addEventListener('click',e=>{const project=projects.find(p=>p.id===$('#publish-project')?.value);const url=safePublishedUrl(project&&project.publishedUrl);if(!url){e.preventDefault();toast('Publish this project before opening its website.');return}e.currentTarget.href=url;});$('#payment-paypal-connect')?.addEventListener('click',connectPaypal);$('#payment-paypal-mode')?.addEventListener('change',loadPaymentSettings);$('#payment-paypal-disconnect')?.addEventListener('click',disconnectPaypal);$('#payment-save-crypto')?.addEventListener('click',saveCryptoSettings);$$('[data-view]').forEach(b=>b.addEventListener('click',()=>openView(b.dataset.view)));$$('[data-go]').forEach(b=>b.addEventListener('click',()=>openView(b.dataset.go)));['#new-project','#new-project-top','#empty-create','#projects-create','#projects-empty-create'].forEach(s=>$(s)?.addEventListener('click',()=>openModal()));$('#modal-close').addEventListener('click',closeModal);$('#new-modal').addEventListener('click',e=>{if(e.target.id==='new-modal')closeModal()});$('#new-form').addEventListener('submit',e=>{e.preventDefault();const name=$('#project-name').value.trim();if(name)createProject(name,$('#project-kind').value)});document.addEventListener('click',e=>{const section=e.target.closest('[data-select-section]');if(section){selectedSectionId=section.dataset.selectSection;renderSectionList();syncPreview();return}const edit=e.target.closest('[data-edit]');if(edit){activeId=edit.dataset.edit;openView('editor');return}const duplicate=e.target.closest('[data-duplicate]');if(duplicate){duplicateProject(duplicate.dataset.duplicate);return}const remove=e.target.closest('[data-delete]');if(remove)deleteProject(remove.dataset.delete)});$$('[data-template]').forEach(b=>b.addEventListener('click',()=>{const kind=b.dataset.template;createProject(kind+' Website',kind)}));$('#stockroom-product-form')?.addEventListener('submit',saveStockroomProduct);$('#stockroom-image-file')?.addEventListener('change',e=>{const file=e.target.files?.[0],preview=$('#stockroom-image-preview');if(!preview)return;if(!file){preview.textContent=$('#stockroom-image-ref').value?'Current product image saved in R2.':'Choose an image from your device.';return}if(!/^image\/(jpeg|png|webp|gif)$/.test(file.type)||file.size>5*1024*1024){e.target.value='';preview.textContent='Choose a JPEG, PNG, WebP, or GIF image no larger than 5 MB.';return}showStockroomImagePreview(URL.createObjectURL(file),'Selected: '+file.name+' ('+(file.size/1024).toFixed(0)+' KB). It will upload to R2 when you save.');});$('#stockroom-cancel-edit')?.addEventListener('click',resetStockroomEditor);$('#stockroom-refresh')?.addEventListener('click',initializeStockroomDatabase);$('#stockroom-search')?.addEventListener('input',()=>loadStockroomProducts());$('#stockroom-products')?.addEventListener('click',e=>{if(e.target.closest('[data-stockroom-empty-add]')){$('#stockroom-name').focus();$('#stockroom-product-form').scrollIntoView({behavior:'smooth',block:'center'});return}const edit=e.target.closest('[data-stockroom-edit]');if(edit)void editStockroomProduct(edit.dataset.stockroomEdit);const remove=e.target.closest('[data-stockroom-delete]');if(remove)void archiveStockroomProduct(remove.dataset.stockroomDelete)});$('#editor-project').addEventListener('change',e=>{activeId=e.target.value;loadEditor()});['#site-title','#site-description','#site-button','#site-color','#site-bg'].forEach(s=>$(s).addEventListener('input',syncPreview));$('#save-project').addEventListener('click',saveEditor);$('#download-site').addEventListener('click',download);$$('[data-add-section]').forEach(b=>b.addEventListener('click',()=>{addSection(b.dataset.addSection);toast('Section added. Customize it and save your page.')}));$('#section-title').addEventListener('input',syncPreview);$('#section-body').addEventListener('input',syncPreview);$('#remove-section').addEventListener('click',()=>{const p=activeProject();if(!p)return;p.sections=(p.sections||[]).filter(x=>x.id!==selectedSectionId);selectedSectionId=p.sections[0]?.id||null;renderSectionList();syncPreview()});$$('[data-device]').forEach(b=>{b.setAttribute('aria-pressed',b.dataset.device==='desktop'?'true':'false');b.addEventListener('click',()=>{$$('[data-device]').forEach(x=>{const active=x===b;x.classList.toggle('active',active);x.setAttribute('aria-pressed',active?'true':'false')});const mobile=b.dataset.device==='mobile';$('#canvas-wrap').classList.toggle('mobile-preview',mobile);const frame=$('#site-canvas');if(frame){frame.style.width=mobile?'min(375px, 100%)':'100%';frame.title=mobile?'Mobile website preview (375px viewport)':'Desktop website preview'};})});$('#workspace-name').addEventListener('change',e=>{try{localStorage.setItem('vampiresquid-workspace-name',e.target.value)}catch{}});$('#logout')?.addEventListener('click',()=>{try{if(sessionToken&&accountId!=='guest')fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account_id:accountId,session_token:sessionToken}),keepalive:true}).catch(()=>{})}catch{}try{['vm-account-id','vm-session-token','vm-username','vm-login-time','vm-initial-snapshot-pending'].forEach(k=>sessionStorage.removeItem(k))}catch{}location.replace('/vm.html?logged_out=1')});$('#delete-account')?.addEventListener('click',async()=>{if(!sessionToken||!accountId||accountId==='guest'){toast('Sign in to a regular account before deleting it.');return}const confirmation=prompt('This permanently deletes your account, projects, and saved VM. Type DELETE to continue.');if(confirmation!=='DELETE')return;const button=$('#delete-account');button.disabled=true;button.textContent='Deleting account…';try{const response=await fetch('/api/account/delete',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({account_id:accountId,session_token:sessionToken})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error((data.error||'Account deletion failed')+(Array.isArray(data.failures)?': '+data.failures.join(', '):''));try{localStorage.removeItem(KEY);localStorage.removeItem(DELETED_KEY);['vm-account-id','vm-session-token','vm-username','vm-login-time','vm-initial-snapshot-pending'].forEach(k=>sessionStorage.removeItem(k))}catch{}alert('Your VampireSquid account and account data have been deleted.');location.assign('/vm.html')}catch(error){toast('Could not delete account: '+error.message);button.disabled=false;button.textContent='Delete my account'}})}
bind();renderProjects();

if(!accountId||accountId==='guest'||!sessionToken){const label=$('#session-user');if(label)label.textContent='Not signed in';toast('Preview mode: log in to your account before using account-connected features.');}
else fetch('/api/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account_id:accountId,session_token:sessionToken})}).then(r=>{if(!r.ok)throw new Error('session expired');return r.json()}).then(data=>{const name=typeof data.username==='string'?data.username:'';if(name){try{sessionStorage.setItem('vm-username',name)}catch{}}const label=$('#session-user');if(label)label.textContent=name?'Signed in as '+name:'Signed-in account';toast(name?'Welcome back, '+name+'.':'Your session is active.');loadCloudProjects()}).catch(()=>toast('Your session needs attention. Log in again.'));
if(location.hash==='#editor')openView('editor');
})();