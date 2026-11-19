// The /dev/login page: lets developers get a token, and doubles as the
// smallest reference client for the CSR + PKCE login flow. The UI is built
// with DOM APIs only (no innerHTML), so tokens and user data are never parsed
// as HTML.

/** Returns the page HTML; `nonce` must match the response's CSP header. */
export function devLoginPage(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>FurTodo 开发者登录</title>
    <style nonce="${nonce}">
      body {
        font-family: system-ui, -apple-system, 'Noto Sans TC', sans-serif;
        line-height: 1.6;
        margin: 40px auto;
        max-width: 760px;
        padding: 0 16px;
      }
      code, pre, textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
      }
      textarea {
        height: 4.5em;
        width: 100%;
      }
      pre {
        background: rgba(127, 127, 127, .12);
        border-radius: 6px;
        overflow-x: auto;
        padding: 12px;
      }
      button {
        cursor: pointer;
        font-size: 15px;
        margin: 4px 8px 4px 0;
        padding: 8px 16px;
      }
      img {
        border-radius: 50%;
        vertical-align: middle;
      }
      .error {
        color: #dc2626;
      }
      .muted {
        opacity: .7;
      }
    </style>
  </head>
  <body>
    <h1>FurTodo 开发者登录</h1>
    <p class="muted">
      用 GitHub 登录（账号需创建满一年）获取 access token 来测试 API。
      API 文档：<a href="/docs">/docs</a> ·
      OpenAPI：<a href="/openapi.json">/openapi.json</a> ·
      对接说明：<a href="/integration.md">/integration.md</a>
    </p>
    <div id="app"></div>
    <script type="module" nonce="${nonce}">
      const API_BASE = location.origin;
      const REDIRECT_URI = API_BASE + '/dev/login';
      const app = document.getElementById('app');

      function base64UrlEncode(buffer) {
        return btoa(String.fromCharCode(...new Uint8Array(buffer)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '');
      }

      function randomBase64Url(byteLength) {
        return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
      }

      function element(tag, properties = {}, ...children) {
        const node = Object.assign(document.createElement(tag), properties);
        node.append(...children);
        return node;
      }

      function show(...nodes) {
        app.replaceChildren(...nodes);
      }

      async function startLogin() {
        const verifier = randomBase64Url(32);
        const state = randomBase64Url(16);
        sessionStorage.setItem('pkce', JSON.stringify({verifier, state}));
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(verifier),
        );
        const url = new URL(API_BASE + '/v1/auth/github/authorize');
        url.search = new URLSearchParams({
          redirect_uri: REDIRECT_URI,
          code_challenge: base64UrlEncode(digest),
          code_challenge_method: 'S256',
          state,
        }).toString();
        location.assign(url.toString());
      }

      function tokenBox(label, token) {
        const textArea = element('textarea', {readOnly: true, value: token});
        const copyButton = element('button', {
          textContent: '复制',
          onclick: () => {
            navigator.clipboard.writeText(token);
          },
        });
        return element(
          'div',
          {},
          element('h3', {textContent: label}),
          textArea,
          copyButton,
        );
      }

      function renderSession(session) {
        const token = session.access_token;
        const user = session.user;
        const tokenOutput = element('div');
        const createTokenButton = element('button', {
          textContent: '创建 90 天个人 token（给 AI agent / 脚本）',
          onclick: async () => {
            const response = await fetch(API_BASE + '/v1/auth/tokens', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                name: 'dev-login ' + new Date().toISOString().slice(0, 10),
                expiresInDays: 90,
              }),
            });
            const body = await response.json();
            tokenOutput.replaceChildren(
              response.ok
                ? tokenBox('个人 token（只显示这一次）', body.token)
                : element('p', {
                    className: 'error',
                    textContent: body.error?.message ?? String(response.status),
                  }),
            );
          },
        });
        const logoutButton = element('button', {
          textContent: '退出登录',
          onclick: async () => {
            await fetch(API_BASE + '/v1/auth/logout', {
              method: 'POST',
              headers: {'Authorization': 'Bearer ' + token},
            });
            sessionStorage.removeItem('session');
            renderLogin();
          },
        });
        const eligibility = session.eligibility;
        show(
          element(
            'p',
            {},
            element('img', {src: user.avatarUrl, width: 32, height: 32, alt: ''}),
            ' ',
            element('strong', {textContent: user.login}),
            ' · 账号 ' + eligibility.accountAgeDays + ' 天（需满 ' +
              eligibility.minAccountAgeDays + ' 天）',
          ),
          tokenBox('Access token（30 天滑动有效）', token),
          element('pre', {
            textContent:
              "curl -H 'Authorization: Bearer " + token + "' " +
              API_BASE + '/v1/me',
          }),
          createTokenButton,
          logoutButton,
          tokenOutput,
        );
      }

      function renderLogin(message) {
        const loginButton = element('button', {
          textContent: '用 GitHub 登录',
          onclick: startLogin,
        });
        if (message) {
          show(element('p', {className: 'error', textContent: message}), loginButton);
        } else {
          show(loginButton);
        }
      }

      async function finishLogin(params) {
        const saved = JSON.parse(sessionStorage.getItem('pkce') ?? 'null');
        sessionStorage.removeItem('pkce');
        if (!saved || saved.state !== params.get('state')) {
          renderLogin('state 不符，请重新登录');
          return;
        }
        const response = await fetch(API_BASE + '/v1/auth/token', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: params.get('code'),
            code_verifier: saved.verifier,
            redirect_uri: REDIRECT_URI,
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          renderLogin(body.error?.message ?? '登录失败');
          return;
        }
        sessionStorage.setItem('session', JSON.stringify(body));
        renderSession(body);
      }

      async function main() {
        const params = new URLSearchParams(location.search);
        if (params.has('code') || params.has('error')) {
          history.replaceState(null, '', '/dev/login');
        }
        if (params.get('error')) {
          renderLogin(
            params.get('error') + '：' + (params.get('error_description') ?? ''),
          );
          return;
        }
        if (params.get('code')) {
          await finishLogin(params);
          return;
        }
        const session = JSON.parse(sessionStorage.getItem('session') ?? 'null');
        if (session) {
          renderSession(session);
        } else {
          renderLogin();
        }
      }

      main();
    </script>
  </body>
</html>`;
}
