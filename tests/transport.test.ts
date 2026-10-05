import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {browserTransport} from '../src/transport';

test('browser transport encodes credentials only in HTTPS body, uses cookies and rejects redirects', async () => {
  const dom = new JSDOM('<body></body>', {url:'https://fixture.invalid'}), env = dom.window as any;
  const calls: any[] = [];
  env.XMLHttpRequest = class {
    withCredentials = false; timeout = 0; status = 200; responseURL = 'https://www.toramp.com/login/'; responseText = 'fixture'; onload: any;
    headers: Record<string,string> = {}; method = ''; url = '';
    open(method: string,url: string) {this.method=method;this.url=url;}
    setRequestHeader(key: string,value: string) {this.headers[key]=value;}
    send(body: string) {calls.push({body, credentials:this.withCredentials, headers:this.headers, url:this.url});queueMicrotask(()=>this.onload());}
  };
  const transport = browserTransport(env);
  await transport.request('/login/',{username:'synthetic+name',password:'synthetic&p=word'},'synthetic-csrf');
  assert.equal(calls[0].body,'username=synthetic%2Bname&password=synthetic%26p%3Dword');
  assert.equal(calls[0].credentials,true);assert.equal(calls[0].headers['X-CSRF-TOKEN'],'synthetic-csrf');
  assert.ok(!calls[0].url.includes('password'));
  await assert.rejects(transport.request('//other.invalid/'),/Некорректный адрес/);
  env.XMLHttpRequest = class extends env.XMLHttpRequest {responseURL='https://other.invalid/login/';};
  await assert.rejects(transport.request('/login/'),/другой сайт/);
  env.XMLHttpRequest = class extends env.XMLHttpRequest {responseURL='https://www.toramp.com/login/';status=403;};
  await assert.rejects(transport.request('/login/'),/отклонил запрос/);
  dom.window.close();
});

test('CSRF acquisition shares in-flight frame, keeps it unfocusable and removes it on success', async () => {
  const dom = new JSDOM('<body></body>', {url:'https://fixture.invalid'}), env=dom.window as any;
  const append=env.document.body.appendChild.bind(env.document.body);
  let frames=0;
  env.document.body.appendChild=(frame: any)=>{
    frames++;const result=append(frame);
    assert.equal(frame.tabIndex,-1);assert.equal(frame.getAttribute('aria-hidden'),'true');
    Object.defineProperty(frame,'contentWindow',{value:{document:{URL:'https://www.toramp.com/login/',cookie:'ajax_token=synthetic'}}});
    queueMicrotask(()=>frame.onload());return result;
  };
  const transport=browserTransport(env);
  assert.deepEqual(await Promise.all([transport.token(),transport.token()]),['synthetic','synthetic']);
  assert.equal(frames,1);assert.equal(env.document.querySelectorAll('iframe').length,0);
  dom.window.close();
});

test('blocked CSRF acquisition times out with actionable error and always cleans up', async () => {
  const dom = new JSDOM('<body></body>', {url:'https://fixture.invalid'}), env=dom.window as any;
  const append=env.document.body.appendChild.bind(env.document.body);
  env.document.body.appendChild=(frame: any)=>{
    const result=append(frame);Object.defineProperty(frame,'contentWindow',{get(){throw Error('Blocked by browser');}});return result;
  };
  env.setTimeout=(callback: ()=>void)=>{queueMicrotask(callback);return 1;};
  env.setInterval=()=>2;env.clearInterval=()=>{};env.clearTimeout=()=>{};
  await assert.rejects(browserTransport(env).token(),/не разрешает прямую запись/);
  assert.equal(env.document.querySelectorAll('iframe').length,0);dom.window.close();
});
