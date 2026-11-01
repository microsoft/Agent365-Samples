// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const vm = require('node:vm');
const redirects = require('follow-redirects');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function close(server) {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
}

test('official patched release strips sensitive headers across origins for normal and cross-realm arrays', async () => {
    assert.equal(require('follow-redirects/package.json').version, '1.16.2');
    const target = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(request.headers));
    });
    const source = http.createServer((_request, response) => {
        response.writeHead(302, { location: `http://localhost:${target.address().port}/target` });
        response.end();
    });
    try {
        await listen(target);
        await listen(source);
        for (const sensitiveHeaders of [['X-Test-Secret'], vm.runInNewContext("['X-Test-Secret']")]) {
            const received = await new Promise((resolve, reject) => {
                const request = redirects.http.get({
                    hostname: '127.0.0.1', port: source.address().port, path: '/', family: 4,
                    headers: { 'X-Test-Secret': 'dummy-test-value', 'X-Public-Test': 'visible' },
                    sensitiveHeaders,
                }, response => {
                    let data = '';
                    response.setEncoding('utf8');
                    response.on('data', chunk => { data += chunk; });
                    response.on('end', () => {
                        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
                    });
                });
                request.on('error', reject);
                request.setTimeout(5000, () => request.destroy(new Error('Local redirect test timed out')));
            });
            assert.equal(received['x-test-secret'], undefined);
            assert.equal(received['x-public-test'], 'visible');
        }
    } finally {
        await Promise.all([close(source), close(target)]);
    }
});
