import {BASE} from './models';

export interface Reply {status: number; text: string}
export interface Transport {
  request(path: string, fields?: Record<string, string | number>, csrf?: string): Promise<Reply>;
  token(): Promise<string>;
}
export function browserTransport(env: Window & typeof globalThis): Transport {
  let tokenJob: Promise<string> | undefined;
  return {
    request(path, fields, csrf) {
      if (!/^\/(?!\/)/.test(path) || new URL(path, BASE).origin !== BASE) return Promise.reject(Error('Некорректный адрес Toramp.'));
      return new Promise((resolve, reject) => {
        const xhr = new env.XMLHttpRequest();
        xhr.open(fields ? 'POST' : 'GET', BASE + path, true);
        xhr.withCredentials = true; xhr.timeout = 25000;
        if (fields) xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        if (csrf) xhr.setRequestHeader('X-CSRF-TOKEN', csrf);
        xhr.onload = () => {
          if (xhr.responseURL && new URL(xhr.responseURL).origin !== BASE) return reject(Error('Toramp перенаправил запрос на другой сайт.'));
          if (xhr.status < 200 || xhr.status >= 300) return reject(Error(xhr.status === 401 || xhr.status === 403 ? 'Toramp отклонил запрос. Проверьте вход и повторите.' : 'Toramp временно недоступен. Повторите позже.'));
          resolve({status: xhr.status, text: xhr.responseText});
        };
        xhr.onerror = () => reject(Error('Не удалось подключиться к Toramp. Проверьте интернет и поддержку устройства.'));
        xhr.ontimeout = () => reject(Error('Toramp отвечает слишком долго. Повторите позже.'));
        xhr.send(fields ? Object.keys(fields).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(fields[key])).join('&') : null);
      });
    },
    token() {
      // Feature-tested on installed file-origin Tizen Lampa. Never weaken browser policy.
      if (tokenJob) return tokenJob;
      const job = new Promise<string>((resolve, reject) => {
        const frame = env.document.createElement('iframe');
        let done = false, blocked = false, csp = false;
        let interval: number, timer: number;
        frame.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;border:0';
        frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
        function violation(event: SecurityPolicyViolationEvent) {if (event.effectiveDirective.indexOf('frame') >= 0) csp = true;}
        function finish(value?: string) {
          if (done) return; done = true;
          env.clearInterval(interval); env.clearTimeout(timer);
          env.document.removeEventListener('securitypolicyviolation', violation);
          frame.remove();
          if (value) resolve(value);
          else reject(Error(blocked || csp ? 'Эта версия Lampa не разрешает прямую запись в Toramp.' : 'Не удалось подготовить сохранение. Проверьте вход и повторите.'));
        }
        function inspect() {
          try {
            const doc = frame.contentWindow?.document;
            if (!doc || new URL(doc.URL).origin !== BASE) return;
            const match = doc.cookie.match(/(?:^|;\s*)ajax_token=([^;]+)/);
            if (match) finish(decodeURIComponent(match[1]));
          } catch {blocked = true;}
        }
        env.document.addEventListener('securitypolicyviolation', violation);
        frame.onload = inspect; frame.src = BASE + '/login/'; env.document.body.appendChild(frame);
        interval = env.setInterval(inspect, 500); timer = env.setTimeout(() => {inspect(); finish();}, 12000);
      });
      tokenJob = job;
      job.then(() => {if (tokenJob === job) tokenJob = undefined;}, () => {if (tokenJob === job) tokenJob = undefined;});
      return job;
    }
  };
}
