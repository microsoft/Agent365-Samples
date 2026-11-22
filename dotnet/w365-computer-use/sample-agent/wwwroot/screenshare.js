// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Screenshare SPA bootstrap. Opened from the link the agent posts in chat:
//   1. Read sid + hc from the querystring.
//   2. GET /api/screenshare/config for the CDN origin + SDK version.
//   3. Load the screenshare SDK from the CDN.
//   4. POST /api/screenshare/{sid}/token to exchange sid + hc for the ARI token.
//   5. Mount the viewer and wire the Take / Release / Stop controls.
//
// The screenshare session lasts one ARI token lifetime; there is no re-mint. On
// TOKEN_EXPIRED, the user asks the agent for a new link.

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

    // DEV-ONLY visual cue: when the server reports AuthMode=DevBypass the user
    // identity check is skipped, so make that unmistakable in the UI.
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

        // The SDK appends /screenshare to computerUrl itself — strip a trailing
        // /screenshare from the platform URL if present.
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
            // The link is single-use — the only way back is to ask the agent for a new one.
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
