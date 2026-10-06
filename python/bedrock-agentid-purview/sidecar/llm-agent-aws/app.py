"""
LLM Agent with Weather Tool - Uses LangChain + AWS Bedrock + Agent Identity for secure API calls
This agent demonstrates how an AI agent uses tools with Agent Identity tokens.
"""

import os
import json
import base64
import requests
import time
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
import re
import uuid
import purview_rest as pv   # Microsoft Purview via plain Graph REST (no SDK)

# Rate limiting
last_bedrock_call_time = 0
BEDROCK_RATE_LIMIT_SECONDS = 20

# LangChain imports - using try/except for graceful fallback
LANGCHAIN_AVAILABLE = False
ChatBedrock = None
tool = None

try:
    from langchain_aws import ChatBedrock
    from langchain_core.tools import tool
    from langchain_core.prompts import ChatPromptTemplate
    from langgraph.prebuilt import create_react_agent
    LANGCHAIN_AVAILABLE = True
    print("LangChain with AWS Bedrock loaded successfully")
except ImportError as e:
    print(f"LangChain not fully available: {e}")
    print("Running in direct mode only")

app = Flask(__name__)
CORS(app)

# Configuration
SIDECAR_URL = os.environ.get('SIDECAR_URL', 'http://sidecar:5000')
WEATHER_API_URL = os.environ.get('WEATHER_API_URL', 'http://weather-api:8080')
AGENT_APP_ID = os.environ.get('AGENT_APP_ID', '')
BLUEPRINT_APP_ID = os.environ.get('BLUEPRINT_APP_ID', '')
TENANT_ID = os.environ.get('TENANT_ID', '')
CLIENT_SPA_APP_ID = os.environ.get('CLIENT_SPA_APP_ID', '')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'anthropic.claude-3-sonnet-20240229-v1:0')

# --- Microsoft Purview (DLP + sensitivity labels) — see purview_rest.py -----------------
PURVIEW_ENABLED = os.environ.get('PURVIEW_ENABLED', 'true').lower() == 'true'
PURVIEW_APP_NAME = os.environ.get('PURVIEW_APP_NAME', 'Agent ID Weather Agent (Bedrock)')
# Entra app ID the DLP policy is scoped to (Purview 'Application' location). Default: the Agent Identity.
PURVIEW_LOCATION_APP_ID = os.environ.get('PURVIEW_LOCATION_APP_ID', '') or AGENT_APP_ID
# Call processContent even when protectionScopes says nothing is in scope (keeps the demo visible).
PURVIEW_ALWAYS_EVALUATE = os.environ.get('PURVIEW_ALWAYS_EVALUATE', 'true').lower() == 'true'
# If a Purview call fails (e.g. 403 = consent missing), block the request instead of continuing.
PURVIEW_FAIL_CLOSED = os.environ.get('PURVIEW_FAIL_CLOSED', 'true').lower() == 'true'
# Sensitivity label GUIDs the agent must never send to the LLM (e.g. 'Highly Confidential').
PURVIEW_BLOCKED_LABEL_IDS = {x.strip().lower() for x in os.environ.get('PURVIEW_BLOCKED_LABEL_IDS', '').split(',') if x.strip()}
# SharePoint site whose default document library holds the demo files, e.g. https://contoso.sharepoint.com/sites/PurviewDemo
# Leave empty to read from the signed-in user's OneDrive instead.
PURVIEW_SITE_URL = os.environ.get('PURVIEW_SITE_URL', '').strip().rstrip('/')
PURVIEW_BLOCKED_PROMPT_MSG = ("\u26d4 Your request was blocked by a Microsoft Purview DLP policy. "
                              "The prompt contains sensitive information (for example a credit card or SSN). "
                              "Nothing was sent to the model.")
PURVIEW_BLOCKED_RESPONSE_MSG = ("\u26d4 The response was blocked by a Microsoft Purview DLP policy because it "
                                "contained sensitive information that cannot be disclosed.")

# Store debug info (global for simplicity)
debug_logs = []


def log_debug(step, message, data=None):
    """Log debug information for UI display"""
    entry = {
        "step": step,
        "message": message,
        "data": data
    }
    debug_logs.append(entry)
    print(f"[{step}] {message}")
    if data:
        print(f"    Data: {json.dumps(data, indent=2)[:500]}")


def clear_debug():
    """Clear debug logs for new request"""
    global debug_logs
    debug_logs = []


def decode_jwt_payload(token):
    """Decode JWT payload (without verification) to display claims"""
    try:
        if token.startswith('Bearer '):
            token = token[7:]
        parts = token.split('.')
        if len(parts) != 3:
            return None
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += '=' * padding
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return None


def get_agent_token():
    """Get Agent Identity token from sidecar"""
    log_debug("2.A TOKEN REQUEST", f"Requesting token for Agent: {AGENT_APP_ID}")
    
    try:
        url = f"{SIDECAR_URL}/AuthorizationHeaderUnauthenticated/graph-app?AgentIdentity={AGENT_APP_ID}"
        log_debug("2.B REQUEST URL", f"Sidecar URL: {url}")
        
        response = requests.get(url, timeout=30, headers={"Host": "localhost"})
        response.raise_for_status()
        
        result = response.json()
        auth_header = result.get('authorizationHeader', '')
        
        if auth_header:
            claims = decode_jwt_payload(auth_header)
            if claims:
                global _last_tr_claims
                # Pass through ALL claims from the JWT (same as OBO flow)
                _last_tr_claims = claims
                log_debug("2.C TOKEN RECEIVED", "Got Agent Identity token (TR) from sidecar", {
                    "_jwt_token": {
                        "type": "tr",
                        "title": "\U0001f512 TR \u2014 Autonomous Agent Token (App-Only / Client Credentials)",
                        "css": "tr",
                        "hl": "highlight-purple",
                        "claims": claims
                    }
                })
        
        return auth_header
    except Exception as e:
        log_debug("2. TOKEN ERROR", f"Failed to get token: {str(e)}")
        return None


def get_agent_token_obo(user_token=None):
    """Get Agent Identity token via OBO (On-Behalf-Of) flow using authenticated sidecar endpoint.
    
    OBO flow:
      1. User authenticates → obtains Tc (user access token)
      2. Agent presents Tc to sidecar via /AuthorizationHeader (authenticated endpoint)
      3. Sidecar validates Tc, acquires T1 (blueprint token), performs OBO exchange
      4. Returns delegated agent token (TR) that acts on behalf of the user
    
    Docs: https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-on-behalf-of-oauth-flow
    SDK:  https://learn.microsoft.com/en-us/entra/msidweb/agent-id-sdk/endpoints
    """
    log_debug("OBO 2.A TOKEN REQUEST", f"Requesting OBO token for Agent: {AGENT_APP_ID}", {
        "endpoint": "/AuthorizationHeader/graph (authenticated)",
        "flow": "User Token (Tc) → Sidecar → T1 (Blueprint) → OBO Exchange → TR (Delegated Agent)",
        "vs_autonomous": "/AuthorizationHeaderUnauthenticated/graph-app (no user token needed)",
        "bearer_token_sent": "Tc (user's access token) — sent in Authorization header",
        "why_bearer": "Sidecar needs user's Tc to perform OBO exchange on behalf of that user"
    })
    
    try:
        # OBO uses the AUTHENTICATED endpoint (vs Unauthenticated for autonomous)
        url = f"{SIDECAR_URL}/AuthorizationHeader/graph?AgentIdentity={AGENT_APP_ID}"
        tc_snippet = ""
        if user_token:
            raw = user_token.replace("Bearer ", "") if user_token.startswith("Bearer ") else user_token
            tc_snippet = raw[:32] + "..." + raw[-16:] if len(raw) > 52 else raw
        log_debug("OBO 2.B ENDPOINT", f"Authenticated sidecar URL: {url}", {
            "http_method": "GET",
            "authorization_header": f"Bearer {tc_snippet}" if tc_snippet else "(none — will fail)",
            "header_contains": "Tc — the user's access token obtained via MSAL.js sign-in",
            "note": "Unlike /AuthorizationHeaderUnauthenticated, this endpoint REQUIRES a Bearer token (Tc)",
            "docs": "https://learn.microsoft.com/en-us/entra/msidweb/agent-id-sdk/endpoints"
        })
        
        headers = {"Host": "localhost"}
        if user_token:
            if not user_token.startswith("Bearer "):
                headers["Authorization"] = f"Bearer {user_token}"
            else:
                headers["Authorization"] = user_token
            tc_raw = user_token.replace("Bearer ", "") if user_token.startswith("Bearer ") else user_token
            tc_preview = tc_raw[:32] + "..." + tc_raw[-16:] if len(tc_raw) > 52 else tc_raw
            tc_claims_preview = decode_jwt_payload(tc_raw) or {}
            tc_sub = tc_claims_preview.get('name') or tc_claims_preview.get('sub') or tc_claims_preview.get('oid') or '?'
            tc_aud = tc_claims_preview.get('aud', '?')
            log_debug("OBO 2.C USER TOKEN", f"Sending Tc as Bearer → sidecar will use it for OBO exchange", {
                "bearer_header": f"Authorization: Bearer {tc_preview}",
                "token_owner": f"{tc_sub} (from Tc claims)",
                "token_audience": f"{tc_aud}",
                "sidecar_will_do": "1) Validate Tc  2) Acquire T1 (client_credentials)  3) OBO exchange: Tc + T1 → TR",
                "obo_grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "obo_assertion": "Tc (this Bearer token)",
                "obo_client_assertion": "T1 (Blueprint's client-credentials token)",
                "obo_result": "TR — delegated agent token that acts on behalf of the user"
            })
        else:
            log_debug("OBO 2.C NO USER TOKEN", "No user token provided - sidecar may reject or fall back to app-only", {
                "explanation": "In production, user signs in via MSAL → obtains Tc → passes to agent",
                "required_audience": f"api://{BLUEPRINT_APP_ID}" if BLUEPRINT_APP_ID else "api://<blueprint-client-id>"
            })
        
        response = requests.get(url, timeout=30, headers=headers)
        
        if response.status_code == 200:
            result = response.json()
            auth_header = result.get('authorizationHeader', '')
            
            if auth_header:
                claims = decode_jwt_payload(auth_header)
                if claims:
                    global _last_tr_claims
                    # Pass through ALL claims from the JWT
                    _last_tr_claims = claims
                    log_debug("OBO 2.D TOKEN RECEIVED", "Got delegated agent token (TR) via OBO exchange", {
                        "_jwt_token": {
                            "type": "tr",
                            "title": "\U0001f4aa TR \u2014 Agent OBO Token (Delegated)",
                            "css": "tr",
                            "hl": "highlight-green",
                            "claims": claims
                        }
                    })
            
            return auth_header
        else:
            error_text = response.text[:500]
            log_debug("OBO 2.D ENDPOINT RESPONSE", f"Sidecar returned HTTP {response.status_code}", {
                "status_code": response.status_code,
                "response": error_text,
                "explanation": "Expected: OBO requires a valid user token (Tc) in Authorization header. "
                               "Without it, the authenticated endpoint may return 400/401.",
                "production_fix": "User signs in via MSAL → app receives Tc → passes Bearer Tc to this endpoint"
            })
            return None
    except Exception as e:
        log_debug("OBO 2. ERROR", f"Failed to get OBO token: {str(e)}")
        return None


def get_t1_token_claims():
    """Get the app-only (T1) token claims for display purposes.
    
    In the OBO flow, the sidecar uses T1 (blueprint's client-credentials token)
    as the client_assertion when performing the OBO exchange. We fetch it separately
    here so we can display it in the token viewer alongside Tc and TR.
    
    In the Autonomous flow, T1 IS the final token (returned by get_agent_token).
    """
    try:
        url = f"{SIDECAR_URL}/AuthorizationHeaderUnauthenticated/graph-app?AgentIdentity={AGENT_APP_ID}"
        response = requests.get(url, timeout=30, headers={"Host": "localhost"})
        response.raise_for_status()
        result = response.json()
        auth_header = result.get('authorizationHeader', '')
        if auth_header:
            return decode_jwt_payload(auth_header)
    except Exception:
        pass
    return None


def call_weather_api(city: str, token: str, token_label: str = "TR", is_obo: bool = False):
    """Call Weather API with Agent Identity token"""
    log_debug("3.A API CALL", f"Calling Weather API for: {city}")
    
    try:
        url = f"{WEATHER_API_URL}/weather?city={city}"
        headers = {"Authorization": token}
        
        # Build trimmed Bearer snippet for display
        raw = token.replace("Bearer ", "") if token.startswith("Bearer ") else token
        snippet = raw[:32] + "..." + raw[-16:] if len(raw) > 52 else raw
        if is_obo:
            token_desc = "TR — Delegated Agent Token (acts on behalf of user via OBO)"
        else:
            token_desc = "TR — Autonomous Agent Token (app-only, no user context) per MS docs"
        
        log_debug("3.B API URL", f"URL: {url}", {
            "token_sent": token_label,
            "token_description": token_desc,
            "authorization_header": f"Authorization: Bearer {snippet}",
            "why": f"Weather API validates {token_label} to authorize the agent's request"
        })
        
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        weather_data = response.json()
        log_debug("3.C API RESPONSE", "Got weather data from API", weather_data)
        
        return weather_data
    except Exception as e:
        log_debug("3. WEATHER ERROR", f"API call failed: {str(e)}")
        return None


# ============================================
# Weather Function (works with or without LangChain)
# ============================================
# Global holder for user_token when OBO mode is active (set per-request)
_current_user_token = None
# Delegated Agent Identity token (TR) fetched once per OBO request; tools + Purview reuse it
_current_tr_token = None
# Per-request Purview context (labels seen, resources read, DLP scope/etag)
_purview_ctx = None
# Store last TR (result token) claims for display
_last_tr_claims = None


def get_weather_data(city: str, user_token=None) -> str:
    """
    Get the current weather for a city.
    Uses Agent Identity to securely authenticate with the Weather API.
    If user_token is provided, uses OBO flow via authenticated sidecar endpoint.
    """
    is_obo = user_token is not None
    flow_label = "OBO" if is_obo else "Autonomous"
    log_debug("1. TOOL CALLED", f"Weather function called for city: {city} (flow: {flow_label})")
    
    # Step 1: Get Agent Identity token from sidecar
    if is_obo:
        token = _current_tr_token or get_agent_token_obo(user_token=user_token)
    else:
        token = get_agent_token()
    
    if not token:
        return f"Error: Could not authenticate with Agent Identity ({flow_label}). The sidecar may not be running."
    
    # Step 2: Call Weather API with the token
    token_label = "TR"
    weather = call_weather_api(city, token, token_label=token_label, is_obo=is_obo)
    if not weather:
        return f"Error: Could not get weather data for {city}. The API may have rejected the token."
    
    # Step 3: Format response
    result = f"""Weather for {weather.get('city', city)}:
- Temperature: {weather.get('temperature', 'N/A')}°{weather.get('temperature_unit', 'F')}
- Condition: {weather.get('condition', 'N/A')}
- Humidity: {weather.get('humidity', 'N/A')}%
- Wind Speed: {weather.get('wind_speed', 'N/A')} {weather.get('wind_unit', 'mph')}
- Timestamp: {weather.get('timestamp', 'N/A')} ({weather.get('timezone', 'UTC')})
- Data Source: {weather.get('data_source', 'Weather API')}
- Authentication: Validated by {weather.get('validated_by', 'Agent Identity Token')}
- Agent App ID: {weather.get('agent_app_id', 'N/A')}
- Token Flow: {flow_label}"""
    
    log_debug("4. TOOL RESULT", f"Weather data retrieved ({flow_label})", {"result": result})
    return result



# ============================================
# Purview: sensitivity-label-aware document tool
# ============================================
def _label_catalog():
    """Label id -> name/color/priority for the tenant (fetched once per request)."""
    if _purview_ctx is not None and _purview_ctx.get("catalog") is None:
        _purview_ctx["catalog"] = pv.list_labels(_current_tr_token)
    return (_purview_ctx or {}).get("catalog") or {}


def _document_drive_base() -> str:
    """Graph path prefix for the document library: a SharePoint site (PURVIEW_SITE_URL) or the user's OneDrive."""
    if not PURVIEW_SITE_URL:
        log_debug("2. DOCUMENT SOURCE", "Signed-in user's OneDrive (/me/drive)")
        return "/me/drive"
    if _purview_ctx.get("site") is None:
        site = pv.resolve_site_drive(_current_tr_token, PURVIEW_SITE_URL)
        _purview_ctx["site"] = site
        log_debug("2. DOCUMENT SOURCE", f"SharePoint site resolved: {site.get('site_name')} (default document library)", {
            "api": f"GET /v1.0/sites/{{hostname}}:/{PURVIEW_SITE_URL.split('/', 3)[-1]}",
            "token": "TR (delegated) \u2014 resolves only if the signed-in user can access the site",
            "site_id": site.get("site_id"), "web_url": site.get("web_url"), "drive": site.get("drive_base"),
        })
    return _purview_ctx["site"]["drive_base"]


def read_document(path: str) -> str:
    """Read a .docx from the SharePoint site (or OneDrive) — honouring its sensitivity label.

    1. resolve the document library  -> SharePoint site default library, or /me/drive
    2. extractSensitivityLabels      -> which label(s) the file carries
    3. label gate                    -> refuse files whose label is in PURVIEW_BLOCKED_LABEL_IDS
    4. download + parse              -> text handed to the LLM (encrypted files cannot be read)
    Labels of every file read are remembered so the response can inherit the highest one.
    """
    if not _current_tr_token:
        return ("Error: reading documents requires the OBO (signed-in user) flow — the agent reads the "
                "file with the user's own permissions. Switch Token Flow to OBO and sign in.")
    path = path.strip().strip("'\"")
    log_debug("1. TOOL CALLED", f"Document function called for: {path} (flow: OBO)")
    try:
        drive_base = _document_drive_base()
        item = pv.get_drive_item(_current_tr_token, path, drive_base)
        info = pv.extract_file_label_info(_current_tr_token, path, drive_base)
        label_ids = info["ids"]
        catalog = _label_catalog()
        names = [catalog.get(l, {}).get("name") or info["names"].get(l) or l for l in label_ids]
        log_debug("PURVIEW LABEL 2.A FILE LABEL", f"{item.get('name')} \u2192 {', '.join(names) if names else 'no sensitivity label'}", {
            "api": f"POST /v1.0{drive_base}/root:/{{path}}:/extractSensitivityLabels  (fallback: GET .../listItem?$expand=fields)",
            "label_source": info["source"],
            "token": "TR (delegated) \u2014 the agent only sees files the signed-in user can open",
            "file": item.get("name"), "web_url": item.get("webUrl"),
            "label_ids": label_ids, "label_names": names,
        })
        _purview_ctx["sources"].append({"file": item.get("name"), "labels": names, "url": item.get("webUrl")})
        _purview_ctx["resources"].append({
            "identifier": item.get("id"), "name": item.get("name"), "url": item.get("webUrl"),
            "labelId": label_ids[0] if label_ids else None, "accessType": "read", "status": "success",
            "isCrossPromptInjectionDetected": False,
        })
        blocked = PURVIEW_BLOCKED_LABEL_IDS & set(label_ids)
        if blocked:
            _purview_ctx["label_blocked"].append(item.get("name"))
            log_debug("PURVIEW LABEL 2.B LABEL GATE \u2192 BLOCKED", f"{item.get('name')} is labelled {', '.join(names)} \u2014 not sent to Bedrock", {
                "rule": "PURVIEW_BLOCKED_LABEL_IDS contains this label", "blocked_label_ids": sorted(blocked),
                "enforced_by": "the agent, using Purview label metadata (Purview supplies the label; the agent honours it)",
            })
            return (f"ACCESS DENIED BY SENSITIVITY LABEL: '{item.get('name')}' is labelled {', '.join(names)}. "
                    "This agent is not permitted to process content with that classification. Tell the user the "
                    "document is restricted by its sensitivity label and do NOT guess or invent its contents.")
        _purview_ctx["labels_seen"].extend(label_ids)
        log_debug("PURVIEW LABEL 2.B LABEL GATE \u2192 ALLOWED", f"{item.get('name')} may be processed; content handed to the model", {
            "labels": names or ["(none)"], "blocked_label_ids_configured": sorted(PURVIEW_BLOCKED_LABEL_IDS) or "(none)",
        })
        try:
            text = pv.docx_text(item.get("@microsoft.graph.downloadUrl"))
        except ValueError as e:
            log_debug("PURVIEW LABEL 2.B ENCRYPTED", f"{item.get('name')}: {e}", {
                "explanation": "The label applies encryption; without Purview rights the content is unreadable \u2014 protection is working."})
            return (f"The document '{item.get('name')}' is encrypted by its sensitivity label ({', '.join(names)}) "
                    "and its content cannot be read by this agent. Tell the user this.")
        log_debug("4. TOOL RESULT", f"Document text retrieved ({len(text)} chars)", {"preview": text[:300]})
        return f"Document '{item.get('name')}' (sensitivity label: {', '.join(names) if names else 'none'}):\n\n{text}"
    except pv.PurviewError as e:
        if e.status in (403, 404):
            log_debug("3. ACCESS DENIED / NOT FOUND", f"HTTP {e.status} for '{path}' \u2014 the agent has exactly the signed-in user's permissions, no more", {
                "client_request_id": e.request_id, "detail": e.body,
                "explanation": "403 = the user has no access to the site/file; 404 = wrong path or the user cannot see it",
            })
            return (f"Access denied or not found: '{path}' (HTTP {e.status}). The agent can only open documents the "
                    "signed-in user is permitted to open. Tell the user this; do not guess the contents.")
        log_debug("PURVIEW ERROR", f"Document read failed: {e}", {"client_request_id": e.request_id, "http_status": e.status})
        return f"Error reading '{path}': HTTP {e.status}. {e.body}"


def _extract_doc_path(user_query: str):
    # OneDrive path without spaces, e.g. PurviewDemo/Weather-Ops-Playbook.docx
    m = re.search(r"([\w\-./]+\.docx)", user_query, re.IGNORECASE)
    return m.group(1).strip() if m else None


# ============================================
# Purview: DLP gates around the whole request
# ============================================
def _new_purview_ctx():
    return {"conversation_id": str(uuid.uuid4()), "etag": None, "activities": set(),
            "labels_seen": [], "resources": [], "sources": [], "label_blocked": [], "catalog": None, "site": None}


def _purview_agent_info():
    if not AGENT_APP_ID:
        return None
    info = {"identifier": AGENT_APP_ID, "name": PURVIEW_APP_NAME, "version": "1.0"}
    if BLUEPRINT_APP_ID:
        info["blueprintId"] = BLUEPRINT_APP_ID
    return info


def _process_content_safe(text, activity, sequence, accessed_resources=None):
    """processContent with one retry without optional metadata if the beta API rejects it (400)."""
    kwargs = dict(location_app_id=PURVIEW_LOCATION_APP_ID, app_name=PURVIEW_APP_NAME,
                  conversation_id=_purview_ctx["conversation_id"], sequence=sequence,
                  etag=_purview_ctx["etag"], ip=request.remote_addr)
    try:
        return pv.process_content(_current_tr_token, text, activity, agent=_purview_agent_info(),
                                  accessed_resources=accessed_resources, **kwargs)
    except pv.PurviewError as e:
        if e.status == 400 and (accessed_resources or _purview_agent_info()):
            log_debug("PURVIEW NOTE", "Optional agent/resource metadata rejected by the beta API \u2014 retrying with the minimal payload",
                      {"client_request_id": e.request_id, "detail": e.body})
            return pv.process_content(_current_tr_token, text, activity, **kwargs)
        raise


def _purview_blocked_result(message, reason, meta):
    meta["blocked_reason"] = reason
    return {"response": message, "debug": debug_logs, "success": True, "agent_type": "purview-blocked", "token_flow": "obo"}


def _purview_failure(stage, e, meta):
    log_debug("PURVIEW ERROR", f"Purview {stage} evaluation failed: HTTP {e.status}", {
        "client_request_id": e.request_id, "detail": e.body,
        "hint_403": "Consent missing \u2014 the Agent Identity needs ProtectionScopes.Compute.User + Content.Process.User (check scp in the TR token)",
        "hint_404_400": "Check PURVIEW_LOCATION_APP_ID and that the Purview API is available in this tenant/cloud",
        "fail_closed": PURVIEW_FAIL_CLOSED,
    })
    if PURVIEW_FAIL_CLOSED:
        return (f"\u26d4 Request stopped: Microsoft Purview could not evaluate the {stage} (HTTP {e.status}). "
                f"This agent fails closed. Client-Request-Id: {e.request_id}")
    return None


def purview_prompt_gate(user_message, meta):
    """Gate 1 \u2014 DLP on the user's prompt. Returns a result dict if the request must stop, else None."""
    if not PURVIEW_ENABLED:
        return None
    if not _current_tr_token:
        log_debug("PURVIEW SKIPPED", "Purview DLP is evaluated per signed-in user \u2014 switch Token Flow to OBO to see it", {
            "why": "protectionScopes/compute and processContent run under /me with a delegated token (TR, idtyp=user)",
            "autonomous_mode": "app-only token has no user context; DLP for autonomous agents is out of scope for this POC",
        })
        return None
    try:
        scopes = pv.compute_scopes(_current_tr_token, PURVIEW_LOCATION_APP_ID, PURVIEW_APP_NAME)
        _purview_ctx["etag"], _purview_ctx["activities"] = scopes["etag"], scopes["activities"]
        log_debug("PURVIEW 1.A PROTECTION SCOPES", f"Activities Purview wants evaluated for this user + app: {sorted(scopes['activities']) or 'none'}", {
            "api": "POST /v1.0/me/dataSecurityAndGovernance/protectionScopes/compute",
            "token": "TR (delegated Agent Identity token) \u2014 policies are evaluated for THIS user",
            "policy_location": PURVIEW_LOCATION_APP_ID, "etag": scopes["etag"], "scopes": scopes["raw"],
            "client_request_id": scopes["request_id"],
            "note": None if scopes["activities"] else "No DLP policy targets this app + user yet (policy Application location / user scope / sync delay up to ~1h). PURVIEW_ALWAYS_EVALUATE keeps calling processContent anyway.",
        })
        if "uploadText" in scopes["activities"] or PURVIEW_ALWAYS_EVALUATE:
            r = _process_content_safe(user_message, "uploadText", 0)
            verdict = "BLOCKED" if r["blocked"] else "ALLOWED"
            meta["prompt_verdict"] = verdict
            log_debug(f"PURVIEW 1.B PROMPT DLP \u2192 {verdict}", "User prompt evaluated by Purview DLP before it reaches Bedrock", {
                "api": "POST /beta/me/dataSecurityAndGovernance/processContent", "activity": "uploadText",
                "http_status": r["status"], "policy_actions": r["actions"],
                "protection_scope_state": "modified" if r["scope_changed"] else "notModified",
                "agent_attribution": _purview_agent_info(), "client_request_id": r["request_id"],
            })
            if r["blocked"]:
                log_debug("5. COMPLETE", "Stopped by Purview DLP \u2014 nothing was sent to AWS Bedrock")
                return _purview_blocked_result(PURVIEW_BLOCKED_PROMPT_MSG, "PURVIEW_DLP_PROMPT", meta)
        else:
            meta["prompt_verdict"] = "NOT_IN_SCOPE"
            log_debug("PURVIEW 1.B PROMPT DLP \u2192 SKIPPED", "uploadText is not in the protection scope; no inline evaluation required")
    except pv.PurviewError as e:
        msg = _purview_failure("prompt", e, meta)
        meta["prompt_verdict"] = "ERROR"
        if msg:
            return _purview_blocked_result(msg, "PURVIEW_ERROR", meta)
    return None


def purview_response_gate(result, meta):
    """Gate 3 \u2014 label inheritance for the answer, then DLP on the answer text."""
    if not PURVIEW_ENABLED or not _current_tr_token:
        return
    # Keep the panel tidy: Purview steps go before the final COMPLETE entry
    complete_idx = next((i for i in range(len(debug_logs) - 1, -1, -1) if str(debug_logs[i].get("step", "")).startswith("5. COMPLETE")), None)
    complete_entry = debug_logs.pop(complete_idx) if complete_idx is not None else None

    meta["sources"] = _purview_ctx["sources"]
    if _purview_ctx["label_blocked"]:
        meta["blocked_reason"] = "SENSITIVITY_LABEL"
    if _purview_ctx["labels_seen"]:
        try:
            lbl = pv.compute_inheritance(_current_tr_token, list(dict.fromkeys(_purview_ctx["labels_seen"])))
            meta["output_label"] = {"id": lbl.get("id"), "name": lbl.get("name"), "color": lbl.get("color")}
            log_debug("PURVIEW LABEL 2.C INHERITANCE", f"The answer inherits the sensitivity label: {lbl.get('name')}", {
                "api": "GET /v1.0/security/dataSecurityAndGovernance/sensitivityLabels/computeInheritance(labelIds=[...])",
                "input_label_ids": list(dict.fromkeys(_purview_ctx["labels_seen"])), "inherited_label": lbl,
                "meaning": "Purview computed the most sensitive label among the documents used; the response carries it",
            })
        except pv.PurviewError as e:
            log_debug("PURVIEW ERROR", f"computeInheritance failed: HTTP {e.status}", {"client_request_id": e.request_id, "detail": e.body})

    text = result.get("response") or ""
    if "downloadText" in _purview_ctx["activities"] or PURVIEW_ALWAYS_EVALUATE:
        try:
            r = _process_content_safe(text, "downloadText", 1, accessed_resources=_purview_ctx["resources"] or None)
            verdict = "BLOCKED" if r["blocked"] else "ALLOWED"
            meta["response_verdict"] = verdict
            log_debug(f"PURVIEW 3.A RESPONSE DLP \u2192 {verdict}", "Model/tool response evaluated by Purview DLP before it reaches the user", {
                "api": "POST /beta/me/dataSecurityAndGovernance/processContent", "activity": "downloadText",
                "http_status": r["status"], "policy_actions": r["actions"],
                "accessed_resources_reported": [x.get("name") for x in _purview_ctx["resources"]],
                "client_request_id": r["request_id"],
            })
            if r["blocked"]:
                result["response"] = PURVIEW_BLOCKED_RESPONSE_MSG
                meta["blocked_reason"] = "PURVIEW_DLP_RESPONSE"
        except pv.PurviewError as e:
            msg = _purview_failure("response", e, meta)
            meta["response_verdict"] = "ERROR"
            if msg:
                result["response"] = msg
                meta["blocked_reason"] = "PURVIEW_ERROR"
    else:
        meta["response_verdict"] = "NOT_IN_SCOPE"
        log_debug("PURVIEW 3.A RESPONSE DLP \u2192 SKIPPED", "downloadText is not in the protection scope")

    if complete_entry is not None:
        debug_logs.append(complete_entry)


# Create LangChain tool wrappers if available
if LANGCHAIN_AVAILABLE and tool is not None:
    @tool
    def get_weather(city: str) -> str:
        """
        Get real-time current weather data for any city using a live Weather API.
        
        IMPORTANT: You MUST use this tool to get weather information. Do NOT provide
        weather data from your training data or general knowledge. ALWAYS call this
        tool when the user asks about weather, temperature, conditions, or forecast.
        
        Args:
            city: The name of the city (e.g., "Seattle", "New York", "Tokyo")
        
        Returns:
            Current weather including temperature, condition, humidity, wind speed.
        """
        # Check if OBO mode is active via global token holder
        result = get_weather_data(city, user_token=_current_user_token)
        return result

    @tool
    def read_onedrive_document(path: str) -> str:
        """
        Read a Word document (.docx) from the team's SharePoint document library (or the user's
        OneDrive) and return its text. Use this whenever the user asks to read, open, summarize,
        or answer questions about a document, file, playbook, contract, report or memo. The path
        is the file name (with optional folder) inside the library, e.g. "Weather-Ops-Playbook.docx"
        or "Contracts/Vendor-Contract.docx". If the tool reports the document is restricted by a
        sensitivity label, encrypted, or access denied, tell the user exactly that and stop.
        """
        return read_document(path)


# ============================================
# LangChain Agent Setup with AWS Bedrock
# ============================================
def create_weather_agent():
    """Create LangChain agent with weather tool using AWS Bedrock"""
    
    print(f"[AWS] Creating ChatBedrock instance")
    print(f"[AWS] Model: {BEDROCK_MODEL_ID}")
    print(f"[AWS] Region: {AWS_REGION}")
    
    # Initialize AWS Bedrock LLM
    llm = ChatBedrock(
        model_id=BEDROCK_MODEL_ID,
        region_name=AWS_REGION,
        model_kwargs={
            "temperature": 0.7,
            "max_tokens": 2048
        }
    )
    
    print(f"[AWS] ✓ ChatBedrock instance created successfully")
    
    # Define tools
    tools = [get_weather, read_onedrive_document]
    
    # Don't force tool usage - let Claude decide naturally
    # tool_choice="any" was causing loops
    llm_with_tools = llm.bind_tools(tools)
    
    # Use LangGraph ReAct agent
    from langgraph.prebuilt import create_react_agent
    agent = create_react_agent(llm_with_tools, tools)
    
    return agent


def process_with_langchain(user_query: str):
    """Process query using LangChain agent with AWS Bedrock"""
    global last_bedrock_call_time
    
    # Rate limiting - wait if needed
    time_since_last_call = time.time() - last_bedrock_call_time
    if time_since_last_call < BEDROCK_RATE_LIMIT_SECONDS:
        wait_time = BEDROCK_RATE_LIMIT_SECONDS - time_since_last_call
        log_debug("0. RATE LIMIT", f"Waiting {wait_time:.1f} seconds to avoid AWS throttling...")
        print(f"[AWS] Rate limit: waiting {wait_time:.1f} seconds...")
        time.sleep(wait_time)
    
    log_debug("0. START", f"User query: {user_query}")
    log_debug("0. BEDROCK", f"Sending query to AWS Bedrock (model: {BEDROCK_MODEL_ID})")
    
    print(f"\n{'='*60}")
    print(f"[AWS] Processing query with Bedrock LLM")
    print(f"[AWS] Query: {user_query}")
    print(f"[AWS] Model: {BEDROCK_MODEL_ID}")
    print(f"[AWS] Region: {AWS_REGION}")
    print(f"{'='*60}\n")
    
    try:
        agent = create_weather_agent()
        log_debug("0. AGENT READY", f"LangChain agent created with AWS Bedrock ({BEDROCK_MODEL_ID})")
        
        print(f"[AWS] Invoking Bedrock API...")
        
        # Add system message to encourage ONE tool call
        from langchain_core.messages import SystemMessage
        system_msg = SystemMessage(content=(
            "You have two tools. (1) get_weather: when users ask about weather, call it ONCE with the city name. "
            "(2) read_onedrive_document: when users ask to read, summarize or answer questions about a document, "
            "call it ONCE with the file name/path they gave (e.g. Weather-Ops-Playbook.docx). "
            "Answer only from the returned data. If a tool says a document is restricted by a sensitivity label "
            "or encrypted, say so plainly and do not guess its contents. Do NOT call tools multiple times."))
        
        # Limit recursion to prevent infinite loops
        result = agent.invoke(
            {"messages": [system_msg, ("human", user_query)]},
            {"recursion_limit": 10}  # Max 10 steps to prevent loops
        )
        
        # Check messages for tool calls (just detection, no duplicate logging)
        messages = result.get("messages", [])
        tool_called = False
        city = None
        output = None
        
        for msg in messages:
            if hasattr(msg, 'tool_calls') and msg.tool_calls:
                for tool_call in msg.tool_calls:
                    tool_called = True
                    city = tool_call.get('args', {}).get('city', 'unknown')
                    # Tool execution already logged everything, don't duplicate
        
        # Fallback: If LLM didn't call tool but query is about weather, manually call it
        if not tool_called and not _extract_doc_path(user_query) and any(keyword in user_query.lower() for keyword in ['weather', 'temperature', 'forecast', 'condition']):
            log_debug("1. FALLBACK", "LLM didn't call tool - manually extracting city and calling weather tool")
            
            # Extract city from query
            import re
            clean_query = user_query.strip().rstrip('?').rstrip('.')
            words = clean_query.split()
            
            # Try common patterns
            city = None
            if ' in ' in clean_query.lower():
                city = clean_query.lower().split(' in ')[-1].strip()
            elif ' for ' in clean_query.lower():
                city = clean_query.lower().split(' for ')[-1].strip()
            elif len(words) >= 2:
                city = words[-1]  # Last word
            
            if city:
                city = city.capitalize()
                log_debug("2. CITY DETECTED", f"Extracted city: {city}")
                
                # Manually call the weather tool
                weather_result = get_weather_data(city)
                output = weather_result
                tool_called = True
            else:
                log_debug("2. NO CITY", "Could not extract city from query")
        
        if not tool_called:
            log_debug("1. NO TOOL", "LLM responded without calling weather tool (may have used general knowledge)")
        
        # Extract final message from LangGraph response
        if output is None:
            output = result.get("messages", [])[-1].content if result.get("messages") else "No response"
        
        print(f"[AWS] ✓ Received response from Bedrock")
        print(f"[AWS] Response length: {len(output)} characters")
        
        log_debug("5. COMPLETE", "AWS Bedrock agent finished processing")
        
        # Update rate limit timestamp
        last_bedrock_call_time = time.time()
        
        return {
            "response": output,
            "debug": debug_logs,
            "success": True,
            "agent_type": "bedrock"
        }
    except Exception as e:
        print(f"[AWS] ✗ Bedrock API call failed: {str(e)}")
        import traceback
        traceback.print_exc()
        log_debug("ERROR", f"AWS Bedrock agent failed: {str(e)}")
        return {
            "response": f"Agent error: {str(e)}",
            "debug": debug_logs,
            "success": False,
            "agent_type": "bedrock"
        }


def _extract_city(user_query: str) -> str:
    """Extract city name from a user query about weather."""
    import re
    clean_query = user_query.strip().rstrip('?').rstrip('.')
    
    match = re.search(r'\bin\s+([A-Za-z][A-Za-z\s]*?)$', clean_query, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    
    match = re.search(r'\bfor\s+([A-Za-z][A-Za-z\s]*?)$', clean_query, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    
    words = clean_query.split()
    if words:
        last_word = words[-1]
        common_words = {'weather', 'what', 'is', 'the', 'how', 'today', 'now', 'like'}
        if last_word.lower() not in common_words:
            return last_word
    
    return "Seattle"


def process_without_llm(user_query: str, user_token=None):
    """Process query without LLM (direct tool call).
    If user_token is provided, uses OBO flow."""
    is_obo = user_token is not None
    flow_label = "OBO" if is_obo else "Autonomous"
    log_debug("0. START", f"Processing query (Direct + {flow_label}): {user_query}")
    
    if is_obo:
        log_debug("0. OBO MODE", "User token provided — will use authenticated sidecar endpoint", {
            "endpoint": "/AuthorizationHeader/graph (requires Bearer token)",
            "docs": "https://learn.microsoft.com/en-us/entra/msidweb/agent-id-sdk/endpoints"
        })
    
    doc_path = _extract_doc_path(user_query)
    if doc_path:
        flow_badge = "\U0001f504 OBO" if is_obo else "\u26a1 Autonomous"
        log_debug("1. DIRECT CALL", f"Reading OneDrive document directly: {doc_path} (flow: {flow_label})")
        doc_result = read_document(doc_path)
        log_debug("5. COMPLETE", f"Query processed (Direct + {flow_label})")
        return {
            "response": f"Here's what I found:\n\n{doc_result[:1500]}\n\n\u2705 *Securely retrieved using Agent Identity ({flow_badge})*",
            "debug": debug_logs, "success": True, "agent_type": "direct",
            "token_flow": "obo" if is_obo else "autonomous",
        }

    city = _extract_city(user_query)
    
    log_debug("1. DIRECT CALL", f"Calling weather function directly for: {city} (flow: {flow_label})")
    weather_result = get_weather_data(city, user_token=user_token)
    
    flow_badge = "🔄 OBO" if is_obo else "⚡ Autonomous"
    response = f"""Here's what I found:

{weather_result}

✅ *Securely retrieved using Agent Identity ({flow_badge})*"""
    
    log_debug("5. COMPLETE", f"Query processed (Direct + {flow_label})")
    
    return {
        "response": response,
        "debug": debug_logs,
        "success": True,
        "agent_type": "direct",
        "token_flow": "obo" if is_obo else "autonomous"
    }


def check_bedrock_available():
    """Check if AWS credentials are configured"""
    try:
        import boto3
        # Try to create a bedrock-runtime client
        print(f"[AWS] Checking Bedrock availability in region: {AWS_REGION}")
        bedrock = boto3.client('bedrock-runtime', region_name=AWS_REGION)
        print(f"[AWS] ✓ Bedrock client created successfully")
        print(f"[AWS] Using credentials: {os.environ.get('AWS_ACCESS_KEY_ID', 'NOT SET')[:8]}...")
        return True
    except Exception as e:
        print(f"[AWS] ✗ Bedrock not available: {e}")
        return False


# ============================================
# Flask Routes
# ============================================
@app.route('/')
def index():
    """Serve the chat UI"""
    return render_template_string(CHAT_UI_TEMPLATE)


@app.route('/api/chat', methods=['POST'])
def chat():
    """Handle chat messages.
    
    Accepts:
        message: str - user query
        llm_mode: 'direct' | 'bedrock' - LLM processing mode
        token_flow: 'autonomous' | 'obo' - token acquisition flow
        user_token: str | null - MSAL user access token (required for OBO)
    """
    global _current_user_token
    data = request.json
    user_message = data.get('message', '')
    llm_mode = data.get('llm_mode', data.get('mode', 'direct'))  # backward compat
    token_flow = data.get('token_flow', 'autonomous')
    user_token = data.get('user_token', None)
    
    if not user_message:
        return jsonify({"error": "No message provided"}), 400
    
    # For OBO flow, user_token is required
    if token_flow == 'obo' and not user_token:
        return jsonify({"error": "OBO flow requires a user token. Please sign in first."}), 400
    
    # Set global token for LangChain tool access (tools can't receive params directly)
    global _last_tr_claims
    _current_user_token = user_token if token_flow == 'obo' else None
    _last_tr_claims = None  # Reset for each request
    clear_debug()  # Clear debug logs at start of each request
    
    # Decode Tc (user token) claims for display — pass ALL claims
    tc_claims = None
    if user_token and token_flow == 'obo':
        tc_claims = decode_jwt_payload(user_token)
        if tc_claims:
            log_debug("OBO 0.A USER TOKEN (Tc)", "Decoded user access token from MSAL sign-in", {
                "_jwt_token": {
                    "type": "tc",
                    "title": "\U0001f511 Tc \u2014 User Token (from MSAL sign-in)",
                    "css": "tc",
                    "hl": "highlight",
                    "claims": tc_claims
                }
            })
    
    global _current_tr_token, _purview_ctx
    _current_tr_token = None
    _purview_ctx = _new_purview_ctx()
    purview_meta = {"enabled": PURVIEW_ENABLED, "mode": token_flow, "prompt_verdict": None,
                    "response_verdict": None, "output_label": None, "sources": [], "blocked_reason": None}
    try:
        if token_flow == 'obo':
            # One OBO exchange per request: Purview gates and tools all reuse this delegated TR
            _current_tr_token = get_agent_token_obo(user_token=user_token)
        gate = purview_prompt_gate(user_message, purview_meta)          # Gate 1: prompt DLP
        if gate is not None:
            result = gate
        elif llm_mode == 'bedrock' and LANGCHAIN_AVAILABLE and check_bedrock_available():
            result = process_with_langchain(user_message)
            # Override agent_type to reflect both dimensions
            result['token_flow'] = token_flow
        else:
            result = process_without_llm(user_message, user_token=_current_user_token)
        if gate is None:
            purview_response_gate(result, purview_meta)                   # Gate 3: labels + response DLP
        result['purview'] = purview_meta
    finally:
        _current_user_token = None  # Always clear after request
        _current_tr_token = None
        _purview_ctx = None
    
    # Attach token claims for display (both OBO and Autonomous)
    # Note: full JWT claims are now embedded directly in debug log entries
    # (Tc at step OBO 0.A, T1 inserted before TR, TR at step OBO 2.D)
    if token_flow == 'obo':
        # Fetch T1 claims and insert into debug log BEFORE the TR entry
        t1_claims = get_t1_token_claims()
        if t1_claims:
            t1_entry = {
                "step": "OBO 2.C T1 (Blueprint)",
                "message": "Blueprint app-only token used as client_assertion in OBO exchange",
                "data": {
                    "_jwt_token": {
                        "type": "t1",
                        "title": "\U0001f4dc T1 \u2014 Blueprint Token (App-Only / Client Credentials)",
                        "css": "t1",
                        "hl": "highlight-purple",
                        "claims": t1_claims
                    }
                }
            }
            # Find OBO 2.D (TR) entry and insert T1 right before it
            tr_idx = next((i for i, e in enumerate(result['debug']) if 'OBO 2.D' in e.get('step', '')), None)
            if tr_idx is not None:
                result['debug'].insert(tr_idx, t1_entry)
            else:
                result['debug'].append(t1_entry)
    _last_tr_claims = None
    
    # Add doc links entry at end of debug flow
    result['debug'].append({
        "step": "DOCS",
        "message": "_doc_links",
        "data": None
    })
    
    return jsonify(result)


@app.route('/api/status', methods=['GET'])
def status():
    """Check service status"""
    bedrock_ready = check_bedrock_available()
    return jsonify({
        "bedrock_available": bedrock_ready,
        "aws_region": AWS_REGION,
        "bedrock_model": BEDROCK_MODEL_ID,
        "sidecar_url": SIDECAR_URL,
        "agent_app_id": AGENT_APP_ID[:8] + "..." if AGENT_APP_ID else "not set",
        "purview_enabled": PURVIEW_ENABLED,
        "purview_location_app_id": PURVIEW_LOCATION_APP_ID,
        "purview_blocked_label_ids": sorted(PURVIEW_BLOCKED_LABEL_IDS),
        "purview_site_url": PURVIEW_SITE_URL or "(OneDrive)",
    })


@app.route('/api/config', methods=['GET'])
def config():
    """Return MSAL configuration for browser-side OBO sign-in.
    Only exposes non-secret values needed by MSAL.js."""
    # Dynamically determine redirect URI — respect proxy headers from Container Apps
    scheme = request.headers.get('X-Forwarded-Proto', request.scheme)
    host = request.headers.get('X-Forwarded-Host', request.host)
    redirect_uri = f"{scheme}://{host}"
    return jsonify({
        "tenant_id": TENANT_ID,
        "blueprint_app_id": BLUEPRINT_APP_ID,
        "client_spa_app_id": CLIENT_SPA_APP_ID,
        "agent_app_id": AGENT_APP_ID,
        # Scope targets Blueprint app — sidecar validates aud matches its ClientId (Blueprint)
        # Ref: https://blog.christianposta.com/entra-agent-id-agw/PART-2.html
        "obo_scopes": [f"api://{BLUEPRINT_APP_ID}/access_as_user"] if BLUEPRINT_APP_ID else [],
        "authority": f"https://login.microsoftonline.com/{TENANT_ID}" if TENANT_ID else "",
        "redirect_uri": redirect_uri,
    })


@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({
        "status": "healthy",
        "service": "LLM Weather Agent (AWS Bedrock)",
        "agent_app_id": AGENT_APP_ID[:8] + "..." if AGENT_APP_ID else "not set"
    })


# ============================================
# HTML Template
# ============================================
CHAT_UI_TEMPLATE = '''
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>3P Agent Identity Demo - AWS Bedrock</title>
    <!-- MSAL.js for interactive sign-in (OBO flow) -->
    <script src="https://alcdn.msauth.net/browser/2.38.2/js/msal-browser.min.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #fff;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            height: 100vh;
        }
        .panel {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 20px;
            display: flex;
            flex-direction: column;
        }
        .panel-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 15px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .panel-header h2 { font-size: 1.2rem; font-weight: 600; }
        .icon {
            width: 32px; height: 32px;
            border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            font-size: 1.2rem;
        }
        .icon-chat { background: linear-gradient(135deg, #FF9900 0%, #FF6600 100%); }
        .icon-debug { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
        .chat-messages {
            flex: 1; overflow-y: auto;
            padding: 10px; margin-bottom: 15px;
        }
        .message {
            margin-bottom: 15px; padding: 12px 16px;
            border-radius: 12px; max-width: 85%;
        }
        .message.user {
            background: linear-gradient(135deg, #FF9900 0%, #FF6600 100%);
            margin-left: auto;
        }
        .message.assistant {
            background: rgba(255,255,255,0.1);
        }
        .message.assistant pre {
            background: rgba(0,0,0,0.3);
            padding: 10px; border-radius: 8px;
            overflow-x: auto; font-size: 0.85rem;
            margin-top: 10px;
        }
        .input-area {
            display: flex; gap: 10px;
        }
        .input-area input {
            flex: 1; padding: 12px 16px;
            border: none; border-radius: 12px;
            background: rgba(255,255,255,0.1);
            color: #fff; font-size: 1rem;
        }
        .input-area input::placeholder { color: rgba(255,255,255,0.5); }
        .input-area button {
            padding: 12px 24px;
            border: none; border-radius: 12px;
            background: linear-gradient(135deg, #FF9900 0%, #FF6600 100%);
            color: #fff; font-weight: 600;
            cursor: pointer; transition: transform 0.2s;
        }
        .input-area button:hover { transform: scale(1.05); }
        .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
        .debug-content {
            flex: 1; overflow-y: auto;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.8rem;
        }
        .debug-entry {
            margin-bottom: 12px; padding: 10px;
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
            border-left: 3px solid #FF9900;
        }
        .debug-entry.error { border-left-color: #f5576c; }
        .debug-entry.success { border-left-color: #2ecc71; }
        .debug-entry.obo { border-left-color: #667eea; }
        .debug-step {
            color: #FF9900; font-weight: 600;
            margin-bottom: 4px;
        }
        .debug-entry.error .debug-step { color: #f5576c; }
        .debug-entry.success .debug-step { color: #2ecc71; }
        .debug-entry.obo .debug-step { color: #667eea; }
        .debug-entry.purview { border-left-color: #8661c5; }
        .debug-entry.purview .debug-step { color: #b39ddb; }
        .debug-entry.error.purview { border-left-color: #f5576c; }
        .debug-entry.error.purview .debug-step { color: #f5576c; }
        .pv-badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:0.75rem; font-weight:600; color:#fff; }
        .pv-green { background:#2ecc71; } .pv-red { background:#f5576c; } .pv-grey { background:rgba(255,255,255,0.25); }
        .debug-message { color: rgba(255,255,255,0.9); margin-bottom: 6px; }
        .debug-data {
            background: rgba(0,0,0,0.4);
            padding: 8px; border-radius: 4px;
            overflow-x: auto; white-space: pre-wrap;
            color: #a8e6cf; font-size: 0.75rem;
        }
        .status-bar {
            display: flex; gap: 15px;
            padding: 8px 10px; margin-bottom: 8px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px; font-size: 0.8rem;
        }
        .status-item { display: flex; align-items: center; gap: 5px; }
        .status-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
        }
        .status-dot.online { background: #2ecc71; }
        .status-dot.offline { background: #f5576c; }
        /* ---- Mode selectors (2 rows) ---- */
        .controls-group {
            margin-bottom: 8px;
        }
        .control-row {
            display: flex; gap: 6px;
            padding: 6px;
            background: rgba(0,0,0,0.2); border-radius: 8px;
            margin-bottom: 6px;
        }
        .control-label {
            display: flex; align-items: center;
            font-size: 0.72rem; font-weight: 700;
            color: rgba(255,255,255,0.5);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            padding: 0 8px;
            min-width: 52px;
        }
        .mode-btn {
            flex: 1; padding: 8px 10px;
            border: 2px solid rgba(255,255,255,0.12);
            border-radius: 8px;
            background: rgba(255,255,255,0.04);
            color: rgba(255,255,255,0.6);
            font-size: 0.78rem; font-weight: 600;
            cursor: pointer; transition: all 0.25s;
            text-align: center;
        }
        .mode-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .mode-btn.active {
            background: linear-gradient(135deg, #FF9900 0%, #FF6600 100%);
            border-color: #FF9900; color: #fff;
        }
        .mode-btn.active.obo-active {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-color: #667eea;
        }
        .mode-desc {
            font-size: 0.68rem; font-weight: 400;
            display: block; margin-top: 2px;
            opacity: 0.75;
        }
        /* Sign-in banner */
        .signin-banner {
            display: none;
            padding: 10px 14px;
            background: rgba(102, 126, 234, 0.15);
            border: 1px solid rgba(102, 126, 234, 0.4);
            border-radius: 8px;
            margin-bottom: 8px;
            font-size: 0.82rem;
            align-items: center; gap: 10px;
        }
        .signin-banner.visible { display: flex; }
        .signin-banner .user-info { flex: 1; color: rgba(255,255,255,0.9); }
        .signin-banner .user-email { color: #667eea; font-weight: 600; }
        .signin-btn {
            padding: 7px 16px;
            border: none; border-radius: 6px;
            font-weight: 600; font-size: 0.8rem;
            cursor: pointer; transition: all 0.2s;
        }
        .signin-btn.login {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
        }
        .signin-btn.login:hover { transform: scale(1.05); }
        .signin-btn.logout {
            background: rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.7);
        }
        .signin-btn.logout:hover { background: rgba(255,255,255,0.2); }
        .config-info {
            display: none;
            padding: 8px 10px;
            margin-bottom: 6px;
            background: rgba(255, 153, 0, 0.1);
            border-radius: 8px;
            border-left: 3px solid #FF9900;
            font-size: 0.78rem;
            line-height: 1.5;
        }
        .config-info.visible { display: block; }
        .config-label { color: #FF9900; font-weight: 600; }
        /* Token viewer - removed separate section, cards now inline in debug flow */
        .token-card {
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
            padding: 10px;
            border-left: 3px solid #667eea;
            font-family: 'Monaco','Menlo',monospace;
            font-size: 0.72rem;
        }
        .token-card.tc { border-left-color: #f5a623; }
        .token-card.tr { border-left-color: #9b59b6; }
        .token-card.t1 { border-left-color: #e056fd; }
        .token-card-title {
            font-weight: 700;
            margin-bottom: 8px;
            font-size: 0.82rem;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .token-card.tc .token-card-title { color: #f5a623; }
        .token-card.tr .token-card-title { color: #9b59b6; }
        .token-card.t1 .token-card-title { color: #e056fd; }
        .token-claim {
            display: flex;
            padding: 3px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .token-claim:last-child { border-bottom: none; }
        .claim-key {
            color: rgba(255,255,255,0.5);
            min-width: 100px;
            font-size: 0.7rem;
        }
        .claim-val {
            color: rgba(255,255,255,0.9);
            word-break: break-all;
            font-size: 0.7rem;
        }
        .claim-val.highlight { color: #fdcb6e; font-weight: 600; }
        .claim-val.highlight-purple { color: #e056fd; font-weight: 600; }
        .claim-val.highlight-green { color: #2ecc71; font-weight: 600; }
        @media (max-width: 900px) {
            .container { grid-template-columns: 1fr; }
            .token-columns { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="panel">
            <div class="panel-header">
                <div class="icon icon-chat">&#x1F916;</div>
                <h2>3P Agent Identity Demo - AWS Bedrock</h2>
            </div>

            <!-- Two-row mode selector -->
            <div class="controls-group">
                <div class="control-row">
                    <div class="control-label">LLM</div>
                    <button class="mode-btn active" data-group="llm" data-mode="direct" onclick="setLlmMode('direct')">
                        &#x26A1; Direct
                        <span class="mode-desc">Skip LLM, call tool</span>
                    </button>
                    <button class="mode-btn" data-group="llm" data-mode="bedrock" onclick="setLlmMode('bedrock')">
                        &#x2601;&#xFE0F; Bedrock
                        <span class="mode-desc">LLM decides tools</span>
                    </button>
                </div>
                <div class="control-row">
                    <div class="control-label">Token</div>
                    <button class="mode-btn active" data-group="token" data-mode="autonomous" onclick="setTokenFlow('autonomous')">
                        &#x1F512; Autonomous
                        <span class="mode-desc">No user sign-in</span>
                    </button>
                    <button class="mode-btn" data-group="token" data-mode="obo" onclick="setTokenFlow('obo')">
                        &#x1F465; OBO (User)
                        <span class="mode-desc">Sign in &amp; delegate</span>
                    </button>
                </div>
            </div>

            <!-- OBO sign-in banner -->
            <div class="signin-banner" id="signinBanner">
                <div class="user-info" id="userInfo">
                    &#x1F511; OBO mode requires user sign-in via Microsoft Entra ID
                </div>
                <button class="signin-btn login" id="signinBtn" onclick="msalSignIn()">Sign In</button>
                <button class="signin-btn logout" id="signoutBtn" onclick="msalSignOut()" style="display:none;">Sign Out</button>
            </div>

            <div id="configInfo" class="config-info">
                <span class="config-label">&#x1F4E1; Bedrock Configuration:</span><br>
                <strong>Model:</strong> <span id="modelId">Loading...</span><br>
                <strong>Region:</strong> <span id="awsRegion">Loading...</span><br>
                <strong>Sidecar:</strong> <span id="sidecarUrl">Loading...</span>
            </div>

            <div class="status-bar">
                <div class="status-item">
                    <span class="status-dot" id="bedrockStatus"></span>
                    <span>Bedrock</span>
                </div>
                <div class="status-item">
                    <span class="status-dot online"></span>
                    <span>Sidecar</span>
                </div>
                <div class="status-item">
                    <span class="status-dot online"></span>
                    <span>Weather API</span>
                </div>
                <div class="status-item" id="oboStatusItem" style="display:none;">
                    <span class="status-dot offline" id="oboStatus"></span>
                    <span>User Auth</span>
                </div>
            </div>

            <div class="chat-messages" id="chatMessages">
                <div class="message assistant">
                    &#x1F44B; Hi! I'm a weather agent demonstrating <strong>Microsoft Entra Agent Identity</strong> with <strong>AWS Bedrock</strong>.
                    <br><br>
                    <strong>LLM Mode:</strong><br>
                    &#x26A1; <strong>Direct</strong> &mdash; Skip LLM, call weather tool directly<br>
                    &#x2601;&#xFE0F; <strong>Bedrock</strong> &mdash; Claude decides when to call tools<br>
                    <br>
                    <strong>Token Flow:</strong><br>
                    &#x1F512; <strong>Autonomous</strong> &mdash; Agent gets its own token (no user sign-in)<br>
                    &nbsp;&nbsp;&nbsp;Endpoint: <code>/AuthorizationHeaderUnauthenticated/graph-app</code><br>
                    &#x1F465; <strong>OBO</strong> &mdash; You sign in, agent acts on your behalf<br>
                    &nbsp;&nbsp;&nbsp;Endpoint: <code>/AuthorizationHeader/graph</code> (with your token)<br>
                    <br>
                    Try: <em>"What is weather in Dallas?"</em>
                </div>
            </div>
            <div class="input-area">
                <input type="text" id="userInput" placeholder="Ask about the weather, or: summarize Weather-Ops-Playbook.docx" />
                <button id="sendBtn" onclick="sendMessage()">Send</button>
            </div>
        </div>
        <div class="panel">
            <div class="panel-header">
                <div class="icon icon-debug">&#x1F50D;</div>
                <h2>Agent Identity Token Flow</h2>
            </div>
            <div class="debug-content" id="debugContent">
                <div class="debug-entry">
                    <div class="debug-step">Waiting for query...</div>
                    <div class="debug-message">Send a message to see the token flow</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // ==============================
        // State
        // ==============================
        let llmMode = 'direct';
        let tokenFlow = 'autonomous';
        let msalInstance = null;
        let msalConfig = null;
        let currentUserToken = null;
        let currentAccount = null;

        const chatMessages = document.getElementById('chatMessages');
        const debugContent = document.getElementById('debugContent');
        const userInput = document.getElementById('userInput');
        const sendBtn = document.getElementById('sendBtn');
        const bedrockStatus = document.getElementById('bedrockStatus');
        const configInfo = document.getElementById('configInfo');
        const signinBanner = document.getElementById('signinBanner');
        const userInfo = document.getElementById('userInfo');
        const signinBtn = document.getElementById('signinBtn');
        const signoutBtn = document.getElementById('signoutBtn');
        const oboStatusItem = document.getElementById('oboStatusItem');
        const oboStatus = document.getElementById('oboStatus');

        // ==============================
        // Mode Selectors
        // ==============================
        function setLlmMode(mode) {
            llmMode = mode;
            document.querySelectorAll('[data-group="llm"]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
            configInfo.classList.toggle('visible', mode === 'bedrock');
        }

        function setTokenFlow(flow) {
            tokenFlow = flow;
            document.querySelectorAll('[data-group="token"]').forEach(btn => {
                btn.classList.remove('active', 'obo-active');
                if (btn.dataset.mode === flow) {
                    btn.classList.add('active');
                    if (flow === 'obo') btn.classList.add('obo-active');
                }
            });
            signinBanner.classList.toggle('visible', flow === 'obo');
            oboStatusItem.style.display = flow === 'obo' ? 'flex' : 'none';
            updateOboUI();
        }

        function updateOboUI() {
            if (currentAccount) {
                const name = currentAccount.name || currentAccount.username;
                userInfo.innerHTML = '&#x2705; Signed in as <span class="user-email">' + name + '</span>';
                signinBtn.style.display = 'none';
                signoutBtn.style.display = 'inline-block';
                oboStatus.className = 'status-dot online';
            } else {
                userInfo.innerHTML = '&#x1F511; OBO mode requires user sign-in via Microsoft Entra ID';
                signinBtn.style.display = 'inline-block';
                signoutBtn.style.display = 'none';
                oboStatus.className = 'status-dot offline';
                currentUserToken = null;
            }
        }

        // ==============================
        // MSAL.js Initialization
        // ==============================
        async function initMsal() {
            try {
                const resp = await fetch('/api/config');
                msalConfig = await resp.json();
                const msalClientId = msalConfig.client_spa_app_id || msalConfig.blueprint_app_id;
                if (!msalClientId || !msalConfig.tenant_id) {
                    console.warn('MSAL config incomplete — OBO sign-in disabled');
                    return;
                }
                msalInstance = new msal.PublicClientApplication({
                    auth: {
                        clientId: msalClientId,
                        authority: msalConfig.authority,
                        redirectUri: msalConfig.redirect_uri,
                    },
                    cache: {
                        cacheLocation: 'sessionStorage',
                        storeAuthStateInCookie: false,
                    }
                });
                await msalInstance.initialize();
                // Check for existing session
                const accounts = msalInstance.getAllAccounts();
                if (accounts.length > 0) {
                    currentAccount = accounts[0];
                    await acquireTokenSilent();
                    updateOboUI();
                }
            } catch (e) {
                console.error('MSAL init error:', e);
            }
        }

        async function acquireTokenSilent() {
            if (!msalInstance || !currentAccount || !msalConfig) return null;
            try {
                const result = await msalInstance.acquireTokenSilent({
                    account: currentAccount,
                    scopes: msalConfig.obo_scopes,
                });
                currentUserToken = result.accessToken;
                return result.accessToken;
            } catch (e) {
                console.warn('Silent token failed, need interactive:', e);
                currentUserToken = null;
                return null;
            }
        }

        async function msalSignIn() {
            if (!msalInstance || !msalConfig) {
                addMessage('MSAL not initialized. Check console for errors.', false);
                return;
            }
            try {
                const result = await msalInstance.loginPopup({
                    scopes: msalConfig.obo_scopes,
                });
                currentAccount = result.account;
                currentUserToken = result.accessToken;
                updateOboUI();
                addMessage('&#x2705; Signed in as <strong>' + (currentAccount.name || currentAccount.username) + '</strong>. OBO flow is now active!', false);
            } catch (e) {
                console.error('Sign-in error:', e);
                if (e.errorCode !== 'user_cancelled') {
                    addMessage('Sign-in failed: ' + e.message, false);
                }
            }
        }

        function msalSignOut() {
            if (msalInstance && currentAccount) {
                msalInstance.logoutPopup({ account: currentAccount }).catch(() => {});
            }
            currentAccount = null;
            currentUserToken = null;
            updateOboUI();
        }

        // Init MSAL on page load
        initMsal();

        // ==============================
        // Status check
        // ==============================
        async function checkStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                bedrockStatus.className = 'status-dot ' + (data.bedrock_available ? 'online' : 'offline');
                document.getElementById('modelId').textContent = data.bedrock_model || 'N/A';
                document.getElementById('awsRegion').textContent = data.aws_region || 'N/A';
                document.getElementById('sidecarUrl').textContent = data.sidecar_url || 'N/A';
            } catch (e) {
                bedrockStatus.className = 'status-dot offline';
            }
        }
        checkStatus();
        setInterval(checkStatus, 10000);

        // ==============================
        // Chat helpers
        // ==============================
        function addMessage(content, isUser) {
            const div = document.createElement('div');
            div.className = 'message ' + (isUser ? 'user' : 'assistant');
            div.innerHTML = content.replace(/\\\\n/g, '<br>');
            chatMessages.appendChild(div);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function updateDebug(debugLogs) {
            debugContent.innerHTML = '';
            debugLogs.forEach(entry => {
                const div = document.createElement('div');
                let entryClass = 'debug-entry';
                if (entry.step.includes('ERROR')) entryClass += ' error';
                if (entry.step.includes('COMPLETE') || entry.step.includes('RECEIVED')) entryClass += ' success';
                if (entry.step.startsWith('OBO') || entry.step.includes('OBO')) entryClass += ' obo';
                if (entry.step.includes('PURVIEW')) entryClass += ' purview';
                if (entry.step.includes('BLOCKED')) entryClass += ' error';
                div.className = entryClass;

                let icon = '&#x2705;';
                if (entry.step.includes('ERROR')) icon = '&#x274C;';
                else if (entry.step.includes('BLOCKED')) icon = '&#x26D4;';
                else if (entry.step.includes('PURVIEW')) icon = '&#x1F6E1;&#xFE0F;';
                else if (entry.step.includes('OBO')) icon = '&#x1F504;';

                let html = '<div class="debug-step">' + icon + ' ' + entry.step + '</div>';
                html += '<div class="debug-message">' + entry.message + '</div>';
                if (entry.data && entry.data._jwt_token) {
                    // Render full JWT claims as a token card inline in the flow
                    const tok = entry.data._jwt_token;
                    html += makeTokenCard(tok.title, tok.claims, tok.css, tok.hl);
                } else if (entry.message === '_doc_links') {
                    // Render doc links
                    div.className = 'debug-entry';
                    div.style.borderLeftColor = '#667eea';
                    html = '<div style="font-size:0.68rem; text-align:center; padding:4px 0;">'
                        + '<a href="https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference" target="_blank" style="color:#667eea; text-decoration:none;">&#x1F4D6; Access token claims</a>'
                        + ' | '
                        + '<a href="https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference" target="_blank" style="color:#667eea; text-decoration:none;">ID token claims</a>'
                        + ' | '
                        + '<a href="https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-on-behalf-of-oauth-flow" target="_blank" style="color:#667eea; text-decoration:none;">Agent OBO flow</a>'
                        + ' | '
                        + '<a href="https://learn.microsoft.com/en-us/purview/developer/use-the-api" target="_blank" style="color:#b39ddb; text-decoration:none;">Purview APIs</a>'
                        + '</div>';
                } else if (entry.data) {
                    html += '<div class="debug-data">' + JSON.stringify(entry.data, null, 2) + '</div>';
                }
                div.innerHTML = html;
                debugContent.appendChild(div);
            });
            debugContent.scrollTop = debugContent.scrollHeight;
        }

        // ==============================
        // Purview badges (DLP verdicts + inherited sensitivity label)
        // ==============================
        function purviewBadges(p) {
            if (!p || !p.enabled) return '';
            if (p.mode !== 'obo') return '<br><small>&#x1F6E1;&#xFE0F; <em>Purview: not evaluated (switch to OBO to see DLP under the signed-in user)</em></small>';
            const v = (x) => x === 'BLOCKED' ? '<span class="pv-badge pv-red">&#x26D4; BLOCKED</span>'
                            : x === 'ALLOWED' ? '<span class="pv-badge pv-green">&#x2705; ALLOWED</span>'
                            : '<span class="pv-badge pv-grey">' + (x || 'n/a') + '</span>';
            let html = '<br><small>&#x1F6E1;&#xFE0F; <strong>Purview DLP</strong> &nbsp;prompt: ' + v(p.prompt_verdict) + ' &nbsp;response: ' + v(p.response_verdict) + '</small>';
            if (p.output_label) {
                html += '<br><small>&#x1F3F7;&#xFE0F; <strong>Sensitivity label (inherited):</strong> <span class="pv-badge" style="background:' + (p.output_label.color || '#8661c5') + '">' + p.output_label.name + '</span></small>';
            }
            if (p.sources && p.sources.length) {
                html += '<br><small>&#x1F4C4; Sources: ' + p.sources.map(s => s.file + ' [' + ((s.labels && s.labels.length) ? s.labels.join(', ') : 'no label') + ']').join('; ') + '</small>';
            }
            if (p.blocked_reason === 'SENSITIVITY_LABEL') html += '<br><small><span class="pv-badge pv-red">&#x26D4; a document was withheld by its sensitivity label</span></small>';
            return html;
        }

        // ==============================
        // Send message
        // ==============================
        async function sendMessage() {
            const message = userInput.value.trim();
            if (!message) return;

            // If OBO mode but not signed in, prompt sign-in
            if (tokenFlow === 'obo' && !currentUserToken) {
                // Try silent first
                const silentToken = await acquireTokenSilent();
                if (!silentToken) {
                    addMessage(message, true);
                    addMessage('&#x1F511; Please sign in first to use OBO mode. Click the <strong>Sign In</strong> button above.', false);
                    return;
                }
            }

            addMessage(message, true);
            userInput.value = '';
            sendBtn.disabled = true;

            const flowLabel = tokenFlow === 'obo' ? 'OBO' : 'Autonomous';
            const llmLabel = llmMode === 'bedrock' ? 'Bedrock' : 'Direct';
            debugContent.innerHTML = '<div class="debug-entry' + (tokenFlow==='obo'?' obo':'') + '"><div class="debug-step">&#x23F3; Processing: ' + llmLabel + ' + ' + flowLabel + '...</div></div>';

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 120000);

                const body = {
                    message: message,
                    llm_mode: llmMode,
                    token_flow: tokenFlow,
                };
                if (tokenFlow === 'obo' && currentUserToken) {
                    body.user_token = currentUserToken;
                }

                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const data = await response.json();

                if (data.error) {
                    addMessage('Error: ' + data.error, false);
                } else {
                    const flowBadge = (data.token_flow === 'obo' || tokenFlow === 'obo')
                        ? '<br><small><em>&#x1F504; OBO Flow (On-Behalf-Of ' + (currentAccount ? currentAccount.name : 'user') + ')</em></small>'
                        : '<br><small><em>&#x1F512; Autonomous Agent</em></small>';
                    const llmBadge = data.agent_type === 'bedrock'
                        ? ' &#x2601;&#xFE0F; Bedrock'
                        : ' &#x26A1; Direct';
                    addMessage(data.response + flowBadge + '<small><em>' + llmBadge + '</em></small>' + purviewBadges(data.purview), false);

                    if (data.debug) {
                        updateDebug(data.debug);
                    }
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    addMessage('Request timed out. Try Direct Mode for faster results.', false);
                } else {
                    addMessage('Error: ' + error.message, false);
                }
            }

            sendBtn.disabled = false;
        }

        // ==============================
        // Token Cards (inline in debug flow)
        // ==============================
        const highlightClaims = [
            'aud', 'sub', 'idtyp', 'appid', 'azp', 'name', 'upn', 'preferred_username',
            'scp', 'roles', 'wids',
            'xms_act_fct', 'xms_sub_fct', 'xms_par_app_azp', 'xms_frd'
        ];

        function renderClaimsHtml(claims, hlClass) {
            if (!claims) return '<em style="color:rgba(255,255,255,0.4)">Not available</em>';
            let html = '';
            for (const [key, val] of Object.entries(claims)) {
                const isHL = highlightClaims.includes(key);
                const valClass = isHL ? 'claim-val ' + hlClass : 'claim-val';
                const displayVal = (val === 'N/A' || val === null || val === undefined)
                    ? '<span style="opacity:0.3">\u2014</span>'
                    : (typeof val === 'object' ? JSON.stringify(val) : String(val));
                html += '<div class="token-claim"><span class="claim-key">' + key + '</span><span class="' + valClass + '">' + displayVal + '</span></div>';
            }
            return html;
        }

        function makeTokenCard(title, claims, cssClass, hlClass) {
            return '<div class="token-card ' + cssClass + '" style="margin-bottom:10px;">'
                + '<div class="token-card-title">' + title + '</div>'
                + renderClaimsHtml(claims, hlClass)
                + '</div>';
        }

        userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
    </script>
    <footer style="text-align:center; padding:16px 0 8px; color:#888; font-size:13px;">
        <a href="https://github.com/razi-rais/3P-Agent-ID-Demo" target="_blank" style="color:#58a6ff; text-decoration:none;">
            &#128279; View source code on GitHub
        </a>
    </footer>
</body>
</html>
'''


if __name__ == '__main__':
    print("=" * 60)
    print("  3P Agent Identity Demo - AWS Bedrock Edition")
    print("=" * 60)
    print(f"  Sidecar URL: {SIDECAR_URL}")
    print(f"  Weather API: {WEATHER_API_URL}")
    print(f"  Agent App ID: {AGENT_APP_ID[:8]}..." if AGENT_APP_ID else "  Agent App ID: NOT SET")
    print(f"  AWS Region: {AWS_REGION}")
    print(f"  Bedrock Model: {BEDROCK_MODEL_ID}")
    print("=" * 60)
    print("  Open http://localhost:3001 in your browser")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=3000, debug=True)
