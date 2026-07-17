// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365ObsToken — acquires an Agent 365 *agent-bound* Observability token from Apex.
//
// The ingest service enforces `{agentId}` in the URL == token `azp`/`appid` and requires
// the app-role (`roles`) claim, so a plain dedicated-app token 403s. We mint an
// agent-bound token via the FMI 3-hop (JWT-bearer client-credentials), sponsored by the
// agent BLUEPRINT app (which the agent identity already federates):
//
//   Hop 1/2 (as blueprint): client_credentials + scope=api://AzureADTokenExchange/.default
//            + fmi_path=<agentId>           => T1 (FMI assertion).
//            Client auth rides as `Authorization: Basic` injected by the
//            `A365_Obs_Token` Named Credential custom header (secret never in Apex/git).
//   Hop 3   (as agent id):  client_credentials + client_id=<agentId>
//            + client_assertion_type=jwt-bearer + client_assertion=T1
//            + scope=<obs>/.default          => agent-bound Observability token.
//            Sent via the `A365_Obs_TokenJwt` Named Credential, which injects NO
//            Authorization header (Hop 3 authenticates with the assertion, not Basic).
//
// MSAL is unavailable in Apex; each hop is a raw application/x-www-form-urlencoded POST.
// `getToken()` caches the agent-bound token (L1 per-transaction static + L2 Platform Cache
// when provisioned; TTL from the JWT `exp`), so a high-frequency emit path does not repeat
// the token exchange on every span. See docs/design.md -> "Token model (FMI 3-hop, agent-bound)".
// Config (tenant/agent/scopes) is sourced from A365ObsConfig (CMDT) with default fallbacks.
public with sharing class A365ObsToken {

    // Named Credentials (defined under namedCredentials/; one-time setup in the README).
    private static final String NC_TOKEN_BASIC = 'A365_Obs_Token';   // Hop 1/2: Basic header injected.
    private static final String NC_TOKEN_JWT = 'A365_Obs_TokenJwt';  // Hop 3:  no Authorization header.

    // Platform Cache (optional). Used opportunistically; absence is non-fatal.
    private static final String CACHE_PARTITION = 'local.A365Obs';
    private static final String CACHE_KEY = 'obsToken';
    // Refresh a little before the real expiry to avoid using a just-expired token.
    private static final Integer EXPIRY_SKEW_SECONDS = 300;     // 5 min safety margin.
    private static final Integer DEFAULT_TTL_SECONDS = 3000;    // ~50 min when exp is unreadable.

    // L1 (per-transaction) cache so repeated emits in one transaction never re-POST,
    // independent of whether Platform Cache capacity is provisioned.
    @TestVisible private static String l1Token;
    @TestVisible private static Long l1ExpiryEpochSeconds;

    public class A365ObsTokenException extends Exception {}

    // Acquire an agent-bound Observability bearer token, cached. Falls back to a fresh
    // token acquisition on a cache miss/expiry. Use this in production paths.
    public static String getToken() {
        Long nowSec = System.now().getTime() / 1000;

        // L1: same-transaction.
        if (String.isNotBlank(l1Token) && l1ExpiryEpochSeconds != null
                && nowSec < l1ExpiryEpochSeconds) {
            return l1Token;
        }

        // L2: Platform Cache (best-effort).
        CachedToken fromCache = readCache();
        if (fromCache != null && nowSec < fromCache.expiryEpochSeconds) {
            l1Token = fromCache.token;
            l1ExpiryEpochSeconds = fromCache.expiryEpochSeconds;
            return l1Token;
        }

        // Miss/expired: acquire fresh and populate both cache levels.
        String token = getTokenNoCache();
        Long expiry = expiryEpochFromJwt(token);
        l1Token = token;
        l1ExpiryEpochSeconds = expiry;
        writeCache(token, expiry, nowSec);
        return token;
    }

    // Acquire an agent-bound Observability bearer token (no caching). Does Hop 1/2 then Hop 3.
    public static String getTokenNoCache() {
        String t1 = acquireT1();
        return acquireObsToken(t1);
    }

    // Clears the per-transaction cache (used by tests).
    @TestVisible
    private static void clearCache() {
        l1Token = null;
        l1ExpiryEpochSeconds = null;
    }

    // Hop 1/2: blueprint client-credentials with fmi_path => FMI assertion (T1).
    @TestVisible
    private static String acquireT1() {
        String body = 'grant_type=client_credentials'
            + '&scope=' + EncodingUtil.urlEncode(A365ObsConfig.fmiScope(), 'UTF-8')
            + '&fmi_path=' + EncodingUtil.urlEncode(A365ObsConfig.agentId(), 'UTF-8');
        return postForToken(NC_TOKEN_BASIC, body, 'Hop1/2');
    }

    // Hop 3: JWT-bearer client-assertion => agent-bound Observability token.
    @TestVisible
    private static String acquireObsToken(String t1) {
        String body = 'grant_type=client_credentials'
            + '&client_id=' + EncodingUtil.urlEncode(A365ObsConfig.agentId(), 'UTF-8')
            + '&client_assertion_type=' + EncodingUtil.urlEncode('urn:ietf:params:oauth:client-assertion-type:jwt-bearer', 'UTF-8')
            + '&client_assertion=' + EncodingUtil.urlEncode(t1, 'UTF-8')
            + '&scope=' + EncodingUtil.urlEncode(A365ObsConfig.obsScope(), 'UTF-8');
        return postForToken(NC_TOKEN_JWT, body, 'Hop3');
    }

    // ---- Token caching helpers -------------------------------------------------

    private class CachedToken {
        String token;
        Long expiryEpochSeconds;
    }

    // Reads the L2 (Platform Cache) token. Any error (no partition/capacity) => null.
    private static CachedToken readCache() {
        try {
            Cache.OrgPartition partition = Cache.Org.getPartition(CACHE_PARTITION);
            if (partition == null || !partition.contains(CACHE_KEY)) {
                return null;
            }
            Map<String, Object> stored = (Map<String, Object>) partition.get(CACHE_KEY);
            if (stored == null) {
                return null;
            }
            CachedToken ct = new CachedToken();
            ct.token = (String) stored.get('token');
            ct.expiryEpochSeconds = (Long) stored.get('exp');
            return String.isBlank(ct.token) || ct.expiryEpochSeconds == null ? null : ct;
        } catch (Exception e) {
            // Platform Cache unavailable in this org — degrade to no L2 cache.
            return null;
        }
    }

    // Writes the L2 (Platform Cache) token. Best-effort; never throws.
    private static void writeCache(String token, Long expiryEpochSeconds, Long nowSec) {
        try {
            Cache.OrgPartition partition = Cache.Org.getPartition(CACHE_PARTITION);
            if (partition == null) {
                return;
            }
            Integer ttl = (Integer) (expiryEpochSeconds - nowSec);
            if (ttl == null || ttl <= 0) {
                ttl = DEFAULT_TTL_SECONDS;
            }
            // Platform Cache org TTL ceiling is 48h; our tokens are ~1h so no clamp needed.
            partition.put(CACHE_KEY,
                new Map<String, Object>{ 'token' => token, 'exp' => expiryEpochSeconds },
                ttl);
        } catch (Exception e) {
            // No cache capacity — fine, we simply re-acquire next transaction.
        }
    }

    // Derives an absolute expiry (epoch seconds, minus a safety skew) from the JWT `exp`
    // claim. Falls back to now + DEFAULT_TTL when the token can't be parsed.
    @TestVisible
    private static Long expiryEpochFromJwt(String jwt) {
        Long nowSec = System.now().getTime() / 1000;
        try {
            List<String> parts = jwt.split('\\.');
            if (parts.size() >= 2) {
                String payloadJson = base64UrlDecode(parts[1]);
                Map<String, Object> claims = (Map<String, Object>) JSON.deserializeUntyped(payloadJson);
                Object expObj = claims.get('exp');
                if (expObj != null) {
                    Long exp = (expObj instanceof Long) ? (Long) expObj : Long.valueOf(String.valueOf(expObj));
                    return exp - EXPIRY_SKEW_SECONDS;
                }
            }
        } catch (Exception e) {
            // Unparseable token — use the conservative default below.
        }
        return nowSec + DEFAULT_TTL_SECONDS;
    }

    private static String base64UrlDecode(String input) {
        String b64 = input.replace('-', '+').replace('_', '/');
        Integer pad = Math.mod(b64.length(), 4);
        if (pad > 0) {
            b64 += '===='.substring(pad);
        }
        return EncodingUtil.base64Decode(b64).toString();
    }

    // Shared token-endpoint POST + access_token extraction.
    private static String postForToken(String namedCredential, String body, String hopLabel) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:' + namedCredential + '/' + A365ObsConfig.tenantId() + '/oauth2/v2.0/token');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        req.setHeader('Accept', 'application/json');
        req.setTimeout(20000);
        req.setBody(body);

        HttpResponse res = new Http().send(req);
        Integer status = res.getStatusCode();
        if (status < 200 || status >= 300) {
            throw new A365ObsTokenException(hopLabel + ' token request failed: HTTP '
                + status + ' ' + res.getBody());
        }
        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        String accessToken = (String) parsed.get('access_token');
        if (String.isBlank(accessToken)) {
            throw new A365ObsTokenException(hopLabel + ' response had no access_token: ' + res.getBody());
        }
        return accessToken;
    }
}