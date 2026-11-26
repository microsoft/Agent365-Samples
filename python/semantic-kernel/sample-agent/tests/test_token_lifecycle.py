# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Offline cache lifecycle and bounded credential-acquisition regression tests."""

import asyncio
import base64
import json
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import msal
import requests
from microsoft_agents.authentication.msal import MsalAuth
from microsoft_agents.hosting.core import AgentAuthConfiguration, AuthTypes

from observability import app_token_resolver as tokens


def app_token(agent="agent", tenant="tenant", **overrides):
    claims = {
        "appid": agent,
        "tid": tenant,
        "aud": next(iter(tokens.OBSERVABILITY_AUDIENCES)),
        "exp": time.time() + 3600,
    }
    claims.update(overrides)
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


class TokenLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.resolver = tokens.AppTokenResolver()
        self.manager = SimpleNamespace(get_default_connection=lambda: object())

    async def prefetch(self, agent="agent", tenant="tenant"):
        await self.resolver.prefetch(self.manager, tenant, agent)

    async def test_token_churn_is_bounded_and_eviction_allows_reacquisition(self):
        with patch.object(tokens, "CACHE_CAPACITY", 3), patch.object(
            tokens, "_acquire_with_hosting",
            side_effect=lambda _, tenant, agent: {"access_token": app_token(agent, tenant)},
        ) as acquire:
            for index in range(10):
                await self.prefetch(f"agent-{index}")
                self.assertLessEqual(len(self.resolver._tokens), 3)
            self.assertEqual(len(self.resolver._tokens), 3)
            self.assertNotIn(("tenant", "agent-0"), self.resolver._tokens)
            cached = self.resolver._tokens[("tenant", "agent-9")][0]
            self.assertEqual(self.resolver.resolve("AGENT-9", "TENANT"), cached)
            await self.prefetch("agent-0")
            self.assertEqual(acquire.call_count, 11)

    async def test_failures_are_bounded_and_backoff_expires(self):
        with patch.object(tokens, "CACHE_CAPACITY", 3), patch.object(
            tokens, "_acquire_with_hosting", side_effect=RuntimeError("synthetic failure")
        ) as acquire, patch.object(tokens.time, "time", return_value=1000):
            for index in range(10):
                with self.assertRaises(RuntimeError):
                    await self.prefetch(f"agent-{index}")
                self.assertLessEqual(len(self.resolver._failures), 3)
            await self.prefetch("agent-9")
            self.assertEqual(acquire.call_count, 10)
            with patch.object(tokens.time, "time", return_value=1060):
                with self.assertRaises(RuntimeError):
                    await self.prefetch("agent-9")
                self.assertEqual(acquire.call_count, 11)
                self.assertEqual(self.resolver._failures, {("tenant", "agent-9"): 1120})

    async def test_operations_prune_unrelated_expired_entries(self):
        for operation in ("resolve", "prefetch"):
            with self.subTest(operation=operation):
                self.resolver._tokens[("old", "agent")] = ("old-token", 1060)
                self.resolver._failures[("old", "agent")] = 1000
                with patch.object(tokens.time, "time", return_value=1000):
                    if operation == "resolve":
                        with self.assertLogs(tokens.logger, "WARNING"):
                            self.assertIsNone(self.resolver.resolve("", ""))
                    else:
                        await self.prefetch("", "")
                self.assertEqual(self.resolver._tokens, {})
                self.assertEqual(self.resolver._failures, {})

    async def test_clear_removes_tokens_and_backoff_and_allows_retry(self):
        token = app_token()
        with patch.object(tokens, "_acquire_with_hosting", return_value={"access_token": token}) as acquire:
            await self.prefetch()
            self.resolver._failures[("tenant", "other")] = time.time() + 60
            self.resolver.clear()
            self.assertEqual(self.resolver._tokens, {})
            self.assertEqual(self.resolver._failures, {})
            await self.prefetch()
            self.assertEqual(acquire.call_count, 2)
            self.assertEqual(self.resolver.resolve("AGENT", "TENANT"), token)

    async def test_fresh_token_reuse_and_refresh_failure_preserve_usable_token(self):
        token = app_token(exp=1300)
        with patch.object(tokens.time, "time", return_value=900), patch.object(
            tokens, "_acquire_with_hosting", return_value={"access_token": token}
        ) as acquire:
            await self.prefetch()
            await self.prefetch()
            acquire.assert_called_once()
            with patch.object(tokens.time, "time", return_value=1000), patch.object(
                tokens, "_acquire_with_hosting", side_effect=requests.Timeout
            ) as failed:
                with self.assertRaises(requests.Timeout):
                    await self.prefetch()
                await self.prefetch()
                failed.assert_called_once()
                self.assertEqual(self.resolver.resolve("agent", "tenant"), token)
            with patch.object(tokens.time, "time", return_value=1240):
                with self.assertLogs(tokens.logger, "WARNING"):
                    self.assertIsNone(self.resolver.resolve("agent", "tenant"))
                self.assertEqual(self.resolver._tokens, {})
                self.assertEqual(self.resolver._failures, {})

    async def test_clear_discards_in_flight_result(self):
        started, release, finished = threading.Event(), threading.Event(), threading.Event()

        def acquire(*_):
            started.set()
            release.wait(2)
            finished.set()
            return {"access_token": app_token()}

        with patch.object(tokens, "_acquire_with_hosting", side_effect=acquire):
            task = asyncio.create_task(self.prefetch())
            try:
                await self.wait_event(started)
                self.resolver.clear()
            finally:
                release.set()
                await task
                await self.wait_event(finished)
        self.assertEqual(self.resolver._tokens, {})
        self.assertEqual(self.resolver._failures, {})

    async def test_timeout_backoff_and_outstanding_worker_admission(self):
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        slots = threading.BoundedSemaphore(1)

        def acquire(*_):
            started.set()
            release.wait(2)
            finished.set()
            return {"access_token": app_token()}

        with patch.object(tokens, "_WORKERS", slots), patch.object(
            tokens, "PREFETCH_TIMEOUT_SECONDS", 0.03
        ), patch.object(tokens, "_acquire_with_hosting", side_effect=acquire) as acquire_mock:
            try:
                before = time.monotonic()
                with self.assertRaises(TimeoutError):
                    await self.prefetch()
                self.assertLess(time.monotonic() - before, 1)
                await self.wait_event(started)
                self.assertFalse(slots.acquire(blocking=False))
                await self.prefetch()
                with self.assertRaisesRegex(RuntimeError, "workers are busy"):
                    await self.prefetch("another-agent")
                self.assertEqual(acquire_mock.call_count, 1)
                self.assertEqual(self.resolver._tokens, {})
            finally:
                release.set()
                await self.wait_event(finished)
                # The worker completion callback releases its admission slot.
                for _ in range(100):
                    if slots.acquire(blocking=False):
                        slots.release()
                        break
                    await asyncio.sleep(0.005)
                else:
                    self.fail("Completed worker did not release its slot")
        self.assertEqual(self.resolver._tokens, {})

    async def test_cancellation_retains_worker_slot_and_sets_backoff(self):
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        slots = threading.BoundedSemaphore(1)

        def acquire(*_):
            started.set()
            release.wait(2)
            finished.set()
            return {"access_token": app_token()}

        with patch.object(tokens, "_WORKERS", slots), patch.object(
            tokens, "_acquire_with_hosting", side_effect=acquire
        ):
            task = asyncio.create_task(self.prefetch())
            try:
                await self.wait_event(started)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertIn(("tenant", "agent"), self.resolver._failures)
                self.assertFalse(slots.acquire(blocking=False))
            finally:
                release.set()
                await self.wait_event(finished)
                await asyncio.sleep(0.02)
        self.assertEqual(self.resolver._tokens, {})

    async def test_validation_still_rejects_non_app_or_wrong_identity_tokens(self):
        for claims in (
            {"scp": "delegated"}, {"appid": "other"}, {"tid": "other"},
            {"aud": "other"}, {"exp": time.time() + 59},
        ):
            with self.subTest(claims=claims):
                self.resolver.clear()
                with patch.object(
                    tokens, "_acquire_with_hosting",
                    return_value={"access_token": app_token(**claims)},
                ):
                    with self.assertRaises(RuntimeError):
                        await self.prefetch()
                self.assertEqual(self.resolver._tokens, {})
                self.assertIn(("tenant", "agent"), self.resolver._failures)

    async def test_untrusted_error_details_are_not_exposed(self):
        with patch.object(
            tokens, "_acquire_with_hosting", return_value={"error": "synthetic-secret"}
        ), self.assertRaisesRegex(RuntimeError, "^Observability token request failed$"):
            await self.prefetch()

    async def wait_event(self, event):
        for _ in range(400):
            if event.is_set():
                return
            await asyncio.sleep(0.005)
        self.fail("Offline worker did not reach expected state")


class BoundedTransportTests(unittest.TestCase):
    def configuration(self, auth_type=AuthTypes.client_secret):
        return AgentAuthConfiguration(
            auth_type=auth_type, client_id="blueprint", tenant_id="tenant",
            client_secret="synthetic-secret", federated_client_id="managed-identity",
        )

    def test_http_timeout_overrides_missing_and_unbounded_caller_timeouts(self):
        client = tokens._BoundedHttpClient()
        try:
            with patch.object(client._session, "request", side_effect=requests.Timeout) as request:
                for method, supplied in ((client.get, {}), (client.post, {"timeout": None})):
                    with self.assertRaises(requests.Timeout):
                        method("https://offline.invalid", **supplied)
                    self.assertEqual(request.call_args.kwargs["timeout"], tokens.HTTP_TIMEOUT_SECONDS)
                    self.assertFalse(request.call_args.kwargs["allow_redirects"])
        finally:
            client.close()

    def test_transport_shares_total_budget_and_stops_after_deadline(self):
        client = tokens._BoundedHttpClient(deadline=1010)
        try:
            with patch.object(client._session, "request") as request:
                with patch.object(tokens.time, "monotonic", return_value=1008):
                    client.get("https://offline.invalid")
                self.assertEqual(request.call_args.kwargs["timeout"], 2)
                with patch.object(tokens.time, "monotonic", return_value=1010):
                    with self.assertRaises(requests.Timeout):
                        client.post("https://offline.invalid")
                request.assert_called_once()
        finally:
            client.close()

    def test_msal_export_discovery_and_token_transport_are_bounded_and_closed(self):
        seen = []

        def construct(*args, **kwargs):
            self.assertEqual(kwargs["timeout"], tokens.HTTP_TIMEOUT_SECONDS)
            transport = kwargs["http_client"]
            transport.get("https://offline.invalid/discovery")
            seen.append(transport)
            return SimpleNamespace(
                acquire_token_for_client=lambda **_: transport.post("https://offline.invalid/token")
            )

        with patch.object(
            requests.Session, "request", return_value={"access_token": "synthetic"}
        ) as request, patch.object(requests.Session, "close") as close, patch.object(
            tokens.msal, "ConfidentialClientApplication", side_effect=construct
        ):
            result = tokens._acquire("tenant", "agent", "assertion")
        self.assertEqual(result, {"access_token": "synthetic"})
        self.assertEqual(request.call_count, 2)
        for call in request.call_args_list:
            self.assertEqual(call.kwargs["timeout"], tokens.HTTP_TIMEOUT_SECONDS)
        close.assert_called_once()
        self.assertEqual(len(seen), 1)

    def test_hosting_sdk_fmi_uses_isolated_bounded_transport(self):
        connection = MsalAuth(self.configuration())
        original_clients = dict(connection._msal_auth_client_map)
        fake = object.__new__(msal.ConfidentialClientApplication)
        fake.acquire_token_for_client = Mock(return_value={"access_token": "assertion"})

        def construct(**kwargs):
            self.assertEqual(kwargs["client_credential"], "synthetic-secret")
            self.assertEqual(kwargs["timeout"], tokens.HTTP_TIMEOUT_SECONDS)
            self.assertIsInstance(kwargs["http_client"], tokens._BoundedHttpClient)
            kwargs["http_client"].get("https://offline.invalid/discovery")
            return fake

        with patch.object(requests.Session, "request") as request, patch.object(
            tokens.msal, "ConfidentialClientApplication", side_effect=construct
        ), patch.object(tokens, "_acquire", return_value={"access_token": "export"}) as acquire:
            result = tokens._acquire_with_hosting(connection, "tenant", "agent")
        self.assertEqual(result, {"access_token": "export"})
        self.assertEqual(connection._msal_auth_client_map, original_clients)
        fake.acquire_token_for_client.assert_called_once_with(
            ["api://AzureAdTokenExchange/.default"], data={"fmi_path": "agent"}
        )
        self.assertEqual(request.call_args.kwargs["timeout"], tokens.HTTP_TIMEOUT_SECONDS)
        args, kwargs = acquire.call_args
        self.assertEqual(args, ("tenant", "agent", "assertion"))
        self.assertGreater(kwargs["deadline"], time.monotonic())
        acquire.assert_called_once()

    def test_fmi_http_timeout_stops_before_export_token_acquisition(self):
        connection = MsalAuth(self.configuration())
        with patch.object(requests.Session, "request", side_effect=requests.Timeout), patch.object(
            tokens, "_acquire"
        ) as acquire, patch.object(requests.Session, "close") as close:
            with self.assertRaises(requests.Timeout):
                tokens._acquire_with_hosting(connection, "tenant", "agent")
        acquire.assert_not_called()
        close.assert_called_once()

    def test_federated_and_idpm_managed_identity_requests_are_bounded(self):
        for mode in (AuthTypes.federated_credentials, AuthTypes.identity_proxy_manager):
            with self.subTest(mode=mode):
                transport = tokens._BoundedHttpClient()
                provider = tokens._BoundedHostingAuth(self.configuration(mode), transport)
                identity = Mock()
                identity.acquire_token_for_client.return_value = {"access_token": "assertion"}

                def managed_identity(*args, **kwargs):
                    self.assertIs(kwargs["http_client"], transport)
                    kwargs["http_client"].get("http://offline.invalid/identity", timeout=None)
                    return identity

                def confidential(**kwargs):
                    self.assertIs(kwargs["http_client"], transport)
                    self.assertEqual(kwargs["client_credential"]["client_assertion"](), "assertion")
                    return object()

                try:
                    with patch.object(requests.Session, "request") as request, patch.object(
                        tokens.msal, "ManagedIdentityClient", side_effect=managed_identity
                    ), patch.object(
                        tokens.msal, "ConfidentialClientApplication", side_effect=confidential
                    ):
                        provider._create_client_application("tenant")
                    self.assertEqual(request.call_args.kwargs["timeout"], tokens.HTTP_TIMEOUT_SECONDS)
                finally:
                    transport.close()

    def test_service_fabric_transport_replacement_fails_closed(self):
        transport = tokens._BoundedHttpClient()
        try:
            with self.assertRaises(ValueError), patch.object(
                requests.Session, "request", side_effect=AssertionError("Unexpected network")
            ):
                msal.managed_identity._create_service_fabric_http_client(
                    transport, "https://offline.invalid", "0" * 40
                )
        finally:
            transport.close()

    def test_custom_connection_fails_closed_without_invoking_unbounded_helper(self):
        connection = SimpleNamespace(get_agentic_application_token=Mock())
        with self.assertRaisesRegex(RuntimeError, "MSAL hosting connection"):
            tokens._acquire_with_hosting(connection, "tenant", "agent")
        connection.get_agentic_application_token.assert_not_called()


if __name__ == "__main__":
    unittest.main()
