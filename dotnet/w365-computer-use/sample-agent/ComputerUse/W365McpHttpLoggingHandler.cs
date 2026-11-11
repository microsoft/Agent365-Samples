// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Diagnostics;
using System.Net;
using System.Text;

namespace W365ComputerUseSample.ComputerUse;

internal sealed class W365McpHttpLoggingHandler(
    ILogger<W365McpHttpLoggingHandler> logger, IConfiguration configuration) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var started = DateTimeOffset.UtcNow;
        var timer = Stopwatch.StartNew();
        var captureEnabled = CaptureEnabled();
        CapturingContent? captured = null;
        if (captureEnabled && request.Content != null && IsJson(request.Content))
        {
            captured = new CapturingContent(request.Content);
            request.Content = captured;
        }
        var endpoint = request.RequestUri?.GetComponents(
            UriComponents.SchemeAndServer | UriComponents.Path, UriFormat.UriEscaped);
        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            if (captureEnabled && CaptureEnabled())
            {
                var summary = RequestSummary(captured);
                logger.LogWarning(
                    "W365 MCP capture: TimestampUtc={TimestampUtc:o}, Method={HttpMethod}, Endpoint={Endpoint}, Status={Status}, DurationMs={DurationMs}, TraceId={TraceId}, FailureType={FailureType}, RpcMethod={RpcMethod}, RpcId={RpcId}, Authorization={Authorization}, UserObjectId={UserObjectId}, AuxiliaryAuthorization={AuxiliaryAuthorization}, RequestJson={RequestJson}.",
                    started, request.Method, endpoint, "no-response", timer.Elapsed.TotalMilliseconds,
                    Activity.Current?.TraceId.ToString(), ex.GetType().Name, summary.Method, summary.Id,
                    CapturedHeader(request, "Authorization", "CaptureRawAuthorization"),
                    CapturedHeader(request, "user-object-id", "CaptureUserObjectId"),
                    CapturedHeader(request, "x-ms-authorization-auxiliary", "CaptureRawAuxiliaryAuthorization"),
                    summary.Json);
            }
            throw;
        }
        timer.Stop();
        if (!response.IsSuccessStatusCode)
        {
            logger.LogWarning(
                "W365 MCP HTTP {Method} {Endpoint} returned {StatusCode}. RequestId={RequestId}, CorrelationId={CorrelationId}.",
                request.Method, endpoint, (int)response.StatusCode,
                GetResponseId(response, "request-id") ?? GetResponseId(response, "x-ms-request-id"),
                GetResponseId(response, "x-ms-correlation-request-id"));
        }
        if (captureEnabled && CaptureEnabled())
        {
            var summary = RequestSummary(captured);
            var traceId = Activity.Current?.TraceId.ToString();
            var requestId = GetResponseId(response, "request-id") ?? GetResponseId(response, "x-ms-request-id");
            var correlationId = GetResponseId(response, "x-ms-correlation-request-id");
            var statusCode = (int)response.StatusCode;
            var success = response.IsSuccessStatusCode;
            var eventIndex = 0;
            void LogResponse(string responseJson)
            {
                if (!CaptureEnabled()) return;
                logger.LogWarning(
                    "W365 MCP capture: TimestampUtc={TimestampUtc:o}, Method={HttpMethod}, Endpoint={Endpoint}, Status={StatusCode}, DurationMs={DurationMs}, TraceId={TraceId}, RequestId={RequestId}, CorrelationId={CorrelationId}, RpcMethod={RpcMethod}, RpcId={RpcId}, Authorization={Authorization}, UserObjectId={UserObjectId}, AuxiliaryAuthorization={AuxiliaryAuthorization}, RequestJson={RequestJson}, ResponseCaptureMode={ResponseCaptureMode}, ResponseEventIndex={ResponseEventIndex}, ResponseJson={ResponseJson}, ErrorJson={ErrorJson}.",
                    started, request.Method, endpoint, statusCode, timer.Elapsed.TotalMilliseconds,
                    traceId, requestId, correlationId, summary.Method, summary.Id,
                    CapturedHeader(request, "Authorization", "CaptureRawAuthorization"),
                    CapturedHeader(request, "user-object-id", "CaptureUserObjectId"),
                    CapturedHeader(request, "x-ms-authorization-auxiliary", "CaptureRawAuxiliaryAuthorization"),
                    summary.Json,
                    "raw", eventIndex++, responseJson, success ? null : responseJson);
            }
            if (response.Content.Headers.ContentType?.MediaType?.Equals(
                "text/event-stream", StringComparison.OrdinalIgnoreCase) == true)
            {
                response.Content = new W365McpResponseCaptureContent(
                    response.Content, LogResponse, CaptureEnabled);
                LogResponse("""{"capture":"sse-response-captured-as-consumed"}""");
            }
            else
            {
                response.Content = new W365McpResponseCaptureContent(
                    response.Content, LogResponse, CaptureEnabled, isSse: false);
                LogResponse("""{"capture":"response-captured-as-consumed"}""");
            }
        }
        return response;
    }

    private bool CaptureEnabled() =>
        configuration.GetValue<bool>("W365:Diagnostics:CapturePayloads")
        && configuration.GetValue<DateTimeOffset?>("W365:Diagnostics:CaptureUntilUtc") is { } until
        && until > DateTimeOffset.UtcNow && logger.IsEnabled(LogLevel.Warning);

    private string CapturedHeader(HttpRequestMessage request, string headerName, string settingName)
    {
        if (!CaptureEnabled() || !configuration.GetValue<bool>($"W365:Diagnostics:{settingName}"))
            return "[not-captured]";
        if (!request.Headers.TryGetValues(headerName, out var values))
            return "[absent]";
        var value = string.Join(", ", values);
        return value.Length <= 16 * 1024 ? value
            : $"[{headerName.ToLowerInvariant()}-header-exceeds-16384-characters]";
    }

    private static bool IsJson(HttpContent content) =>
        content.Headers.ContentType?.MediaType is { } type
        && (type.Equals("application/json", StringComparison.OrdinalIgnoreCase)
            || type.EndsWith("+json", StringComparison.OrdinalIgnoreCase));

    private static (string? Method, string? Id, string Json) RequestSummary(CapturingContent? content)
    {
        if (content == null) return (null, null, """{"capture":"no-json-request-body"}""");
        if (content.OverLimit) return (null, null, """{"capture":"request-exceeds-16384-bytes"}""");
        try
        {
            return W365McpPayloadCapture.SummarizeRequest(content.Bytes);
        }
        catch (DecoderFallbackException)
        {
            return (null, null, """{"capture":"request-json-not-captured"}""");
        }
    }

    private static string? GetResponseId(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) && values.FirstOrDefault() is { Length: <= 128 } value
            && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or ':')
            ? value
            : null;

    private sealed class CapturingContent : HttpContent
    {
        private readonly HttpContent _inner;
        private readonly MemoryStream _capture = new();
        internal bool OverLimit { get; private set; }
        internal byte[] Bytes => _capture.ToArray();

        internal CapturingContent(HttpContent inner)
        {
            _inner = inner;
            foreach (var header in inner.Headers)
            {
                Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
        }

        protected override bool TryComputeLength(out long length)
        {
            length = _inner.Headers.ContentLength ?? 0;
            return _inner.Headers.ContentLength.HasValue;
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            SerializeToStreamAsync(stream, context, CancellationToken.None);

        protected override async Task SerializeToStreamAsync(
            Stream stream, TransportContext? context, CancellationToken cancellationToken)
        {
            _capture.SetLength(0);
            OverLimit = false;
            using var tee = new CaptureWriteStream(stream, this);
            await _inner.CopyToAsync(tee, context, cancellationToken).ConfigureAwait(false);
        }

        internal void Capture(ReadOnlySpan<byte> buffer)
        {
            var remaining = W365McpPayloadCapture.MaxBodyBytes - (int)_capture.Length;
            _capture.Write(buffer[..Math.Min(remaining, buffer.Length)]);
            OverLimit |= buffer.Length > remaining;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { _inner.Dispose(); _capture.Dispose(); }
            base.Dispose(disposing);
        }
    }

    private sealed class CaptureWriteStream(Stream destination, CapturingContent capture) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => destination.Flush();
        public override Task FlushAsync(CancellationToken cancellationToken) => destination.FlushAsync(cancellationToken);
        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            destination.Write(buffer);
            capture.Capture(buffer);
        }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await destination.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
            capture.Capture(buffer.Span);
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
