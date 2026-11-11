// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Net;
using System.Text;

namespace W365ComputerUseSample.ComputerUse;

internal sealed class W365McpResponseCaptureContent : HttpContent
{
    private readonly HttpContent inner;
    private readonly IResponseCapture capture;

    public W365McpResponseCaptureContent(HttpContent inner, Action<string> logResponse,
        Func<bool> captureEnabled, bool isSse = true)
    {
        this.inner = inner;
        capture = isSse
            ? new SseCapture(logResponse, captureEnabled)
            : new BodyCapture(logResponse, captureEnabled);
        foreach (var header in inner.Headers) Headers.TryAddWithoutValidation(header.Key, header.Value);
    }

    protected override bool TryComputeLength(out long length)
    {
        length = inner.Headers.ContentLength ?? 0;
        return inner.Headers.ContentLength.HasValue;
    }

    protected override Task<Stream> CreateContentReadStreamAsync() =>
        CreateContentReadStreamAsync(CancellationToken.None);

    protected override Stream CreateContentReadStream(CancellationToken cancellationToken) =>
        new CaptureReadStream(inner.ReadAsStream(cancellationToken), capture);

    protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken) =>
        new CaptureReadStream(await inner.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false), capture);

    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
        SerializeToStreamAsync(stream, context, CancellationToken.None);

    protected override async Task SerializeToStreamAsync(
        Stream stream, TransportContext? context, CancellationToken cancellationToken)
    {
        using var source = await CreateContentReadStreamAsync(cancellationToken).ConfigureAwait(false);
        await source.CopyToAsync(stream, cancellationToken).ConfigureAwait(false);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            capture.Complete(false);
            inner.Dispose();
        }
        base.Dispose(disposing);
    }

    private interface IResponseCapture
    {
        void Read(ReadOnlySpan<byte> bytes);
        void Complete(bool endOfStream);
    }

    private sealed class BodyCapture(
        Action<string> logResponse, Func<bool> captureEnabled) : IResponseCapture
    {
        private readonly MemoryStream body = new();
        private bool ended;

        public void Read(ReadOnlySpan<byte> bytes)
        {
            if (ended) return;
            if (!captureEnabled()) { Stop(); return; }
            if (body.Length + bytes.Length > W365McpPayloadCapture.MaxBodyBytes)
            {
                logResponse("""{"capture":"response-exceeds-16384-bytes"}""");
                Stop();
                return;
            }
            body.Write(bytes);
        }

        public void Complete(bool endOfStream)
        {
            if (ended) return;
            try
            {
                if (!captureEnabled()) return;
                logResponse(endOfStream ? W365McpPayloadCapture.DecodeBody(body.ToArray())
                    : """{"capture":"response-incomplete-or-not-consumed"}""");
            }
            catch (DecoderFallbackException)
            {
                logResponse("""{"capture":"response-body-not-captured"}""");
            }
            finally { Stop(); }
        }

        private void Stop()
        {
            ended = true;
            body.Dispose();
        }
    }

    private sealed class SseCapture(
        Action<string> logResponse, Func<bool> captureEnabled) : IResponseCapture
    {
        private readonly MemoryStream frame = new();
        private int consumed;
        private int events;
        private bool previousCr;
        private bool lineHasContent;
        private bool ended;

        public void Read(ReadOnlySpan<byte> bytes)
        {
            if (ended) return;
            if (!captureEnabled()) { Stop(); return; }
            foreach (var value in bytes)
            {
                if (++consumed > W365McpPayloadCapture.MaxBodyBytes)
                {
                    logResponse("""{"capture":"sse-response-exceeds-16384-bytes"}""");
                    Stop();
                    return;
                }
                if (previousCr && value == '\n') { previousCr = false; continue; }
                previousCr = false;
                if (value is (byte)'\r' or (byte)'\n')
                {
                    frame.WriteByte((byte)'\n');
                    if (!lineHasContent)
                    {
                        EmitFrame();
                        if (ended) return;
                        frame.SetLength(0);
                    }
                    lineHasContent = false;
                    previousCr = value == '\r';
                }
                else
                {
                    frame.WriteByte(value);
                    lineHasContent = true;
                }
            }
        }

        private void EmitFrame()
        {
            try
            {
                var text = new UTF8Encoding(false, true).GetString(frame.GetBuffer(), 0, (int)frame.Length)
                    .TrimStart('\uFEFF');
                var data = new List<string>();
                foreach (var line in text.Split('\n'))
                {
                    if (line == "data") data.Add("");
                    else if (line.StartsWith("data:", StringComparison.Ordinal))
                        data.Add(line.StartsWith("data: ", StringComparison.Ordinal) ? line[6..] : line[5..]);
                }
                if (data.Count == 0) return;
                if (events++ >= 16)
                {
                    logResponse("""{"capture":"sse-response-exceeds-16-events"}""");
                    Stop();
                    return;
                }
                logResponse(string.Join("\n", data));
            }
            catch (DecoderFallbackException)
            {
                logResponse("""{"capture":"sse-response-json-not-captured"}""");
            }
        }

        public void Complete(bool endOfStream)
        {
            if (ended) return;
            if (captureEnabled() && (frame.Length > 0 || consumed == 0))
                logResponse("""{"capture":"sse-response-incomplete-or-not-consumed"}""");
            Stop();
        }

        private void Stop()
        {
            ended = true;
            frame.Dispose();
        }
    }

    private sealed class CaptureReadStream(Stream source, IResponseCapture capture) : Stream
    {
        public override bool CanRead => source.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            var read = source.Read(buffer);
            if (read > 0) capture.Read(buffer[..read]);
            else if (buffer.Length > 0) capture.Complete(true);
            return read;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read > 0) capture.Read(buffer.Span[..read]);
            else if (buffer.Length > 0) capture.Complete(true);
            return read;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { capture.Complete(false); source.Dispose(); }
            base.Dispose(disposing);
        }
        public override void Flush() => source.Flush();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
