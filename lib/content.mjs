import {ApiError} from './protocol.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=(param,message='Unsupported or malformed content block.')=>{throw new ApiError(message,400,param,'unsupported_content');};
export function inlineFile(url,filename,param) {
 const match=typeof url==='string'&&/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
 if(!match||match[2].length%4!==0)fail(param,'Attachments must use an inline base64 data URL; remote URLs and local file paths are unavailable.');
 const mime=match[1].toLowerCase();if(!['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','audio/wav','audio/mpeg'].includes(mime))fail(param,'Unsupported attachment media type.');
 const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.toString('base64')!==match[2])fail(param,'Invalid attachment base64.');
 if(filename!==undefined&&(typeof filename!=='string'||filename.length>256||/[\r\n\0]/.test(filename)))fail(param,'Invalid attachment filename.');
 if(mime==='text/plain'){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail(param,'Text attachments must be valid UTF-8.');}return{type:'text',text:(filename?'File: '+filename+'\n':'')+text};}
 return{type:'file',mime,url,...(filename?{filename}:{} )};
}
export function messageParts(content,param='content') {
 if(typeof content==='string')return[{type:'text',text:content}];
 if(!Array.isArray(content))fail(param);
 return content.map((p,i)=>{
  const at=param+'['+i+']';if(!object(p))fail(at);
  if(p.type==='text'&&typeof p.text==='string'&&Object.keys(p).every(k=>['type','text'].includes(k)))return{type:'text',text:p.text};
  if(p.type==='image_url'&&object(p.image_url)&&Object.keys(p).every(k=>['type','image_url'].includes(k))&&Object.keys(p.image_url).every(k=>['url','detail'].includes(k))&&(p.image_url.detail===undefined||['auto','low','high'].includes(p.image_url.detail))){const file=inlineFile(p.image_url.url,undefined,at);if(!file.mime?.startsWith('image/'))fail(at);return file;}
  if(p.type==='file'&&object(p.file)&&Object.keys(p).every(k=>['type','file'].includes(k))&&Object.keys(p.file).every(k=>['filename','file_data'].includes(k)))return inlineFile(p.file.file_data,p.file.filename,at);
  if(p.type==='input_audio'&&object(p.input_audio)&&Object.keys(p).every(k=>['type','input_audio'].includes(k))&&Object.keys(p.input_audio).every(k=>['data','format'].includes(k))&&['wav','mp3'].includes(p.input_audio.format))return inlineFile('data:audio/'+(p.input_audio.format==='mp3'?'mpeg':'wav')+';base64,'+p.input_audio.data,undefined,at);
  fail(at);
 });
}
