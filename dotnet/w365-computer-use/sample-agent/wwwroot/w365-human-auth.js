// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

'use strict';

const form = document.getElementById('human-auth-form');
const status = document.getElementById('status');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.setAttribute('role', 'status');
    status.textContent = 'Refreshing your authorization...';
    try {
        const response = await fetch('/.auth/refresh', {
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error'
        });
        if (!response.ok) {
            throw new Error('refresh-failed');
        }
        HTMLFormElement.prototype.submit.call(form);
    } catch {
        status.setAttribute('role', 'alert');
        status.textContent = 'Authorization could not be refreshed. Use Sign in with Microsoft below with the same work or school account as your original chat, then retry. No Windows 365 session has been changed.';
        form.setAttribute('aria-busy', 'false');
        button.disabled = false;
        status.focus();
    }
});
