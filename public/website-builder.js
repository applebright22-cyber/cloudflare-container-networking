(()=>{'use strict';
const $=s=>document.querySelector(s);
const status=$('#vs-builder-status');
function say(message){if(status)status.textContent=message}
function setValue(selector,value){const el=$(selector);if(!el)return;el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))}
function addSection(type,title,body){
 const button=$('[data-add-section="'+type+'"]');
 if(!button){say('The visual editor section control is unavailable.');return false}
 button.click();
 setValue('#section-title',title);
 setValue('#section-body',body);
 return true;
}
function build(){
 const project=$('#editor-project');
 if(!project||!project.value){say('Create or select a project first, then build your website.');return}
 const name=($('#vs-business-name')?.value||'Your Business').trim().slice(0,60)||'Your Business';
 const pitch=($('#vs-business-pitch')?.value||'').trim().slice(0,180);
 const type=$('#vs-business-type')?.value||'general';
 const copy={
  professional:{headline:'Trusted expertise. Personal service.',desc:'Practical guidance and dependable support from '+name+'. '+pitch,services:'Professional services built around your goals',about:'We believe great service starts by listening. '+name+' brings care, experience, and a thoughtful approach to every customer.'},
  restaurant:{headline:'Good food. Good company.',desc:'Welcome to '+name+'. '+pitch,services:'Fresh favorites, made with care',about:'At '+name+', we bring people together with welcoming hospitality and food worth coming back for.'},
  retail:{headline:'Find something you’ll love.',desc:'Discover '+name+'. '+pitch,services:'A collection chosen with you in mind',about:name+' is here to make discovering the right products simple, enjoyable, and personal.'},
  creative:{headline:'Ideas made into impact.',desc:name+' helps bring good ideas to life. '+pitch,services:'Creative services with purpose',about:'We combine curiosity, craft, and collaboration to make work that feels considered and gets results.'},
  general:{headline:'A better experience starts here.',desc:'Welcome to '+name+'. '+pitch,services:'How we help you move forward',about:name+' is built around dependable service, clear communication, and doing right by our customers.'}
 }[type];
 setValue('#site-title',copy.headline);
 setValue('#site-description',copy.desc);
 setValue('#site-button',type==='restaurant'?'Explore our menu':type==='retail'?'Explore the collection':'Get in touch');
 const accent=type==='restaurant'?'#d49a55':type==='retail'?'#78b69a':type==='creative'?'#a66bdb':'#a33cff';
 setValue('#site-color',accent);
 addSection('features',copy.services,'Explore the ways '+name+' can help. Thoughtful solutions, clear communication, and quality you can count on.');
 addSection('about','The story behind '+name,copy.about);
 addSection('contact','Let’s work together','Have a question or ready to get started? Reach out to '+name+' and we’ll be happy to help.');
 $('#save-project')?.click();
 say('Website generated in your selected project. Review the live preview and save status, then customize any section.');
}
$('#vs-build-site')?.addEventListener('click',build);
$('#vs-add-services')?.addEventListener('click',()=>{if(addSection('features','Our services','Describe your services and the value they bring.'))say('Services section added. Edit its heading and copy in the visual editor, then save your draft.')});
$('#vs-add-about')?.addEventListener('click',()=>{if(addSection('about','About our business','Tell visitors who you are, what you do, and what makes your business different.'))say('About section added. Edit it in the visual editor, then save your draft.')});
$('#vs-add-contact')?.addEventListener('click',()=>{if(addSection('contact','Contact us','Tell visitors how to reach you and what happens next.'))say('Contact section added. Edit it in the visual editor, then save your draft.')});
$('#vs-preview-site')?.addEventListener('click',()=>{$('#site-canvas')?.scrollIntoView({behavior:'smooth',block:'center'});say('Preview refreshed from the current editor fields.')});
const style=document.createElement('style');
style.textContent='.vs-builder-panel{margin:0 0 18px;padding:18px;border:1px solid #3a3268;border-radius:13px;background:linear-gradient(120deg,#17152f,#101a30)}.vs-builder-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.vs-builder-heading strong,.vs-builder-heading small{display:block}.vs-builder-heading strong{font-size:13px}.vs-builder-heading small{margin-top:5px;color:#9aa8c5;font-size:9px}.vs-builder-engine{font-size:8px;letter-spacing:1px;color:#c8a3ff;white-space:nowrap}.vs-builder-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:15px}.vs-builder-fields label{grid-row:1;color:#aab8d2;font-size:9px}.vs-builder-fields input,.vs-builder-fields select{min-width:0;width:100%;box-sizing:border-box;padding:10px;background:#0a1020;border:1px solid #334363;border-radius:7px;color:#eaf0ff;font-size:10px}.vs-builder-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:13px}.vs-builder-actions .button{font-size:9px}.vs-builder-note{margin:12px 0 0;color:#8f9fbe;font-size:9px;line-height:1.7}@media(max-width:760px){.vs-builder-fields{grid-template-columns:1fr}.vs-builder-heading{flex-direction:column}}';
document.head.appendChild(style);
})();