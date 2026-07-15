// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// W365 Screen Share SPA bootstrap (SDK 1.0.0 public, agent-delegated user-token flow).
//
// Flow:
//   1. Read sid + hc from querystring (the only two params the agent puts in the link).
//   2. Fetch /api/screenshare/config — gets {cdnOrigin, sdkVersion}.
//   3. Dynamically <script src=`{cdnOrigin}/screenshare-sdk/{sdkVersion}/screenshare-embed.js`>.
//   4. POST /api/screenshare/{sid}/token with {hc} body. The page sits behind Azure
//      App Service Authentication (EasyAuth), so the request carries the EasyAuth
//      session cookie automatically (same-origin) and the server reads the user's
//      object id from the X-MS-CLIENT-PRINCIPAL-ID header EasyAuth injects. No
//      Authorization header / Teams SSO token is sent. Server validates oid + hc +
//      state, atomically burns the handoff, returns {screenShareUrl, ariToken, expiresAtUtc}.
//   5. Derive computerUrl = screenShareUrl with the trailing /screenshare stripped — pass
//      the ARI URL verbatim per PARTNER_GUIDE (api-version stays in the URL). Pass
//      viewerUrl = `{cdnOrigin}/screenshare-sdk/{sdkVersion}` so the iframe is loaded from
//      the CDN (origin already allowlisted by ARI — no partner-side CORS).
//   6. new ScreenShareViewer({container, computerUrl, viewerUrl, mode: 'interactive'}).
//   7. viewer.connect(ariToken). Wire Take / Release / Stop buttons + status / error events.
//
// Sample limitations (documented in README):
//   - One screenshare session = one ARI token lifetime (~90 min). No re-mint.
//     On TOKEN_EXPIRED, ask the user to end + restart the W365 session.
//   - Authentication is selected by ScreenShare:AuthMode (reported via /config):
//       * EasyAuth  — the page is protected at the platform level by Azure App
//         Service Authentication; the EasyAuth session cookie rides the same-origin
//         token request and the server reads the user's oid from the injected
//         X-MS-CLIENT-PRINCIPAL-ID header. (Production.)
//       * DevBypass — local/Playground only; the server skips the owner check so the
//         page works in a plain browser tab. A banner makes this obvious.
//     Teams SSO (page embedded in Teams as a tab/dialog/stage) is a documented
//     future extension and is not implemented in this sample.

(function () {
    'use strict';

    var statusEl  = document.getElementById('status');
    var errorEl   = document.getElementById('error-detail');
    var takeBtn   = document.getElementById('btn-take');
    var releaseBtn = document.getElementById('btn-release');
    var stopBtn   = document.getElementById('btn-stop');
    var container = document.getElementById('viewer');

    function setStatus(text, isError) {
        statusEl.textContent = text;
        if (isError) statusEl.classList.add('error');
        else statusEl.classList.remove('error');
    }

    function setError(detail) {
        errorEl.textContent = detail ? String(detail) : '';
    }

    // DEV-ONLY visual cue: when the server reports AuthMode=DevBypass the viewer's
    // identity (owner) check is skipped, so make that unmistakable in the UI.
    function showDevBypassBanner() {
        var banner = document.createElement('div');
        banner.textContent = 'DEV BYPASS — user identity check is disabled. Local/Playground testing only.';
        banner.style.cssText = 'background:#fde7e9;color:#a4262c;border:1px solid #a4262c;'
            + 'border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:12px;font-weight:600;';
        document.body.insertBefore(banner, document.body.firstChild);
    }

    function fatal(message, detail) {
        setStatus(message, true);
        setError(detail);
        takeBtn.disabled = releaseBtn.disabled = stopBtn.disabled = true;
        throw new Error(message);
    }

    function readParams() {
        var qp = new URLSearchParams(window.location.search);
        var sid = qp.get('sid');
        var hc  = qp.get('hc');
        if (!sid || !hc) {
            fatal('Missing required parameters',
                  'Open this page from the link the agent posts in chat. Expected ?sid=...&hc=...');
        }
        return { sid: sid, hc: hc };
    }

    function fetchConfig() {
        return fetch('/api/screenshare/config', { method: 'GET' })
            .then(function (r) {
                if (!r.ok) { fatal('Config fetch failed (' + r.status + ')', r.statusText); }
                return r.json();
            });
    }

    function loadSdk(cdnOrigin, sdkVersion) {
        return new Promise(function (resolve, reject) {
            if (typeof window.ScreenShareViewer === 'function') { resolve(); return; }
            var src = cdnOrigin + '/screenshare-sdk/' + encodeURIComponent(sdkVersion) + '/screenshare-embed.js';
            var s = document.createElement('script');
            s.src = src;
            // Intentionally no crossOrigin attribute — the public CDN does not
            // serve Access-Control-Allow-Origin for opaque script loads. Without
            // crossorigin, the browser fetches/executes the script normally. SRI
            // (PARTNER_GUIDE recommends for prod) does require crossorigin and
            // CDN ACAO support; revisit when the prod CDN exposes both.
            s.onload  = function () {
                if (typeof window.ScreenShareViewer === 'function') resolve();
                else reject(new Error('SDK loaded but ScreenShareViewer global missing'));
            };
            s.onerror = function () { reject(new Error('SDK script load failed: ' + src)); };
            document.head.appendChild(s);
        });
    }

    function exchangeToken(params) {
        return fetch('/api/screenshare/' + encodeURIComponent(params.sid) + '/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Same-origin fetch — the EasyAuth session cookie rides along so the
            // server can read the authenticated user's object id.
            credentials: 'same-origin',
            body: JSON.stringify({ hc: params.hc })
        }).then(function (resp) {
            if (resp.status === 401) {
                fatal('Not signed in',
                      'Your sign-in session has expired. Reload this page to sign in again, or reopen the link from chat.');
            }
            if (!resp.ok) {
                // Surface the HTTP status; body is intentionally generic from the server.
                return resp.text().then(function (text) {
                    fatal('Token exchange failed (' + resp.status + ')', text || resp.statusText);
                });
            }
            return resp.json();
        });
    }

    function startViewer(cfg, payload) {
        var screenShareUrl = payload.screenShareUrl;
        var ariToken       = payload.ariToken;

        // SDK 1.0.0 takes computerUrl verbatim (api-version preserved). The platform returns
        //   https://{pool}.{region}.../computers/{sessionId}/screenshare?api-version=1.0
        // but the SDK appends /screenshare itself — strip the trailing segment if present.
        var computerUrl;
        try {
            var u = new URL(screenShareUrl);
            u.pathname = u.pathname.replace(/\/screenshare\/?$/i, '');
            computerUrl = u.toString();
        } catch (e) { fatal('Invalid screenShareUrl from server', e.message); }

        var viewerUrl = cfg.cdnOrigin + '/screenshare-sdk/' + cfg.sdkVersion;

        setStatus('Connecting…');

        var viewer = new window.ScreenShareViewer({
            container:   container,
            computerUrl: computerUrl,
            viewerUrl:   viewerUrl,
            mode:        'interactive'
        });

        viewer.on('statusChanged', function (state, message) {
            console.log('[screenshare] statusChanged →', state, message || '');
            switch (state) {
                case 'connecting':    setStatus('Connecting…'); break;
                case 'connected':     setStatus('Connected (view-only)'); takeBtn.disabled = false; stopBtn.disabled = false; releaseBtn.disabled = true; break;
                case 'controlling':   setStatus('Connected (controlling)'); takeBtn.disabled = true; releaseBtn.disabled = false; stopBtn.disabled = false; break;
                case 'view-only':     setStatus('Connected (view-only)'); takeBtn.disabled = false; releaseBtn.disabled = true; break;
                case 'reconnecting':  setStatus('Reconnecting…'); break;
                case 'reconnected':   setStatus('Reconnected'); break;
                case 'disconnected':  setStatus('Disconnected'); takeBtn.disabled = releaseBtn.disabled = stopBtn.disabled = true; break;
                default:              setStatus(state + (message ? ': ' + message : ''));
            }
        });

        viewer.on('error', function (code, message) {
            console.error('[screenshare] error', code, message);
            if (code === 'TOKEN_EXPIRED') {
                // Sample limitation: no out-of-turn re-mint. User restarts the W365 session.
                setStatus('Session expired', true);
                setError('Please end this session and start a new one from the agent to get a fresh screen share link.');
                takeBtn.disabled = releaseBtn.disabled = stopBtn.disabled = true;
                return;
            }
            setStatus('Error: ' + code, true);
            setError(message || '');
        });

        takeBtn.addEventListener('click', function () { console.log('[screenshare] takeControl() called'); viewer.takeControl(); });
        releaseBtn.addEventListener('click', function () { console.log('[screenshare] releaseControl() called'); viewer.releaseControl(); });
        stopBtn.addEventListener('click', function () {
            console.log('[screenshare] stop() called');
            viewer.stop();
            setStatus('Session stopped');
            // Hint to the user how to get back in — the link they clicked is single-use,
            // so the only path back is to ask the agent for a new one. The agent listens
            // for any "screen share" + intent word (link / new / again / resend / …) and
            // re-mints a fresh handoff for the active W365 session.
            setError('To reconnect, ask the agent in chat for a new screen share link (e.g. "give me a new screen share link" or "resend the screen share link"). You can close this tab.');
            takeBtn.disabled = releaseBtn.disabled = stopBtn.disabled = true;
        });

        return viewer.connect(ariToken);
    }

    // ---------- Bootstrap ----------
    var params = readParams();

    setStatus('Loading SDK…');
    var cfg;
    fetchConfig()
        .then(function (c) {
            cfg = c;
            if (!cfg.cdnOrigin || !cfg.sdkVersion) {
                fatal('Server config missing cdnOrigin or sdkVersion');
            }
            if (cfg.authMode === 'DevBypass') {
                showDevBypassBanner();
            }
            return loadSdk(cfg.cdnOrigin, cfg.sdkVersion);
        })
        .then(function () {
            setStatus('Authorizing…');
            return exchangeToken(params);
        })
        .then(function (payload) {
            if (!payload) return;
            setStatus('Mounting viewer…');
            return startViewer(cfg, payload);
        })
        .catch(function (err) {
            console.error('[screenshare] fatal', err);
            setStatus('Failed to start screenshare', true);
            setError((err && err.message) || String(err));
        });
})();
