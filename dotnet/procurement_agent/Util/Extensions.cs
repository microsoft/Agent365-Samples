using Azure;
using System.Text;
using System.Text.Json;

namespace ProcurementA365Agent.Util;

public static class Extensions
{
    public static string JoinToString(this IEnumerable<string> strings, string separator = ",") =>
        string.Join(separator, strings);

    public static string FormatDateTimeForOData(this DateTime dateTime) =>
        dateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    public static IEnumerable<T> WhereNotNull<T>(this IEnumerable<T?> source) where T : class =>
        source.Where(x => x != null)!;

    public static async Task<List<T>> ToListAsync<T>(this AsyncPageable<T> source)
    {
        var list = new List<T>();
        await foreach (var item in source)
        {
            list.Add(item);
        }
        return list;
    }

    /// <summary>
    /// Prints the HTTP request details in a well-formatted way to the console.
    /// </summary>
    /// <param name="request">The HTTP request to log</param>
    /// <param name="includeBody">Whether to include the request body in the output</param>
    /// <returns>A task representing the asynchronous operation</returns>
    public static async Task PrintRequestDetailsAsync(this HttpRequest request, bool includeBody = true)
    {
        var sb = new StringBuilder();

        sb.AppendLine(new string('=', 80));
        sb.AppendLine("HTTP REQUEST DETAILS");
        sb.AppendLine(new string('=', 80));

        // Basic request information
        sb.AppendLine($"Method: {request.Method}");
        sb.AppendLine($"Scheme: {request.Scheme}");
        sb.AppendLine($"Host: {request.Host}");
        sb.AppendLine($"Path: {request.Path}");
        sb.AppendLine($"QueryString: {request.QueryString}");
        sb.AppendLine($"Protocol: {request.Protocol}");
        sb.AppendLine($"ContentType: {request.ContentType ?? "N/A"}");
        sb.AppendLine($"ContentLength: {request.ContentLength?.ToString() ?? "N/A"}");
        sb.AppendLine($"IsHttps: {request.IsHttps}");

        // Headers (filtered for security)
        sb.AppendLine();
        sb.AppendLine("HEADERS:");
        sb.AppendLine(new string('-', 40));

        if (request.Headers.Any())
        {
            foreach (var header in request.Headers.OrderBy(h => h.Key))
            {
                // Filter out sensitive headers
                if (IsSensitiveHeader(header.Key))
                {
                    sb.AppendLine($"  {header.Key}: [REDACTED]");
                }
                else
                {
                    var values = string.Join(", ", header.Value.AsEnumerable());
                    sb.AppendLine($"  {header.Key}: {values}");
                }
            }
        }
        else
        {
            sb.AppendLine("  No headers");
        }

        // Query parameters
        if (request.Query.Any())
        {
            sb.AppendLine();
            sb.AppendLine("QUERY PARAMETERS:");
            sb.AppendLine(new string('-', 40));

            foreach (var param in request.Query.OrderBy(q => q.Key))
            {
                var values = string.Join(", ", param.Value.AsEnumerable());
                sb.AppendLine($"  {param.Key}: {values}");
            }
        }

        // Cookies
        if (request.Cookies.Any())
        {
            sb.AppendLine();
            sb.AppendLine("COOKIES:");
            sb.AppendLine(new string('-', 40));

            foreach (var cookie in request.Cookies.OrderBy(c => c.Key))
            {
                sb.AppendLine($"  {cookie.Key}: {cookie.Value}");
            }
        }

        // Request body
        if (includeBody && request.ContentLength > 0)
        {
            sb.AppendLine();
            sb.AppendLine("REQUEST BODY:");
            sb.AppendLine(new string('-', 40));

            try
            {
                // Save the original position
                var originalPosition = request.Body.Position;
                request.Body.Position = 0;

                using var reader = new StreamReader(request.Body, Encoding.UTF8, leaveOpen: true);
                var body = await reader.ReadToEndAsync();

                // Restore the original position
                request.Body.Position = originalPosition;

                if (string.IsNullOrWhiteSpace(body))
                {
                    sb.AppendLine("  (Empty body)");
                }
                else
                {
                    // Truncate very long bodies
                    const int maxBodyLength = 2000;
                    if (body.Length > maxBodyLength)
                    {
                        sb.AppendLine($"  {body[..maxBodyLength]}");
                        sb.AppendLine($"  ... (truncated, full length: {body.Length} characters)");
                    }
                    else
                    {
                        sb.AppendLine($"  {body}");
                    }
                }
            }
            catch (Exception ex)
            {
                sb.AppendLine($"  Error reading body: {ex.Message}");
            }
        }
        else if (includeBody)
        {
            sb.AppendLine();
            sb.AppendLine("REQUEST BODY:");
            sb.AppendLine(new string('-', 40));
            sb.AppendLine("  (No body or ContentLength is 0)");
        }

        // Connection info
        sb.AppendLine();
        sb.AppendLine("CONNECTION INFO:");
        sb.AppendLine(new string('-', 40));
        sb.AppendLine($"  Remote IP: {request.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "N/A"}");
        sb.AppendLine($"  Remote Port: {request.HttpContext.Connection.RemotePort}");
        sb.AppendLine($"  Local IP: {request.HttpContext.Connection.LocalIpAddress?.ToString() ?? "N/A"}");
        sb.AppendLine($"  Local Port: {request.HttpContext.Connection.LocalPort}");

        // Additional context
        sb.AppendLine();
        sb.AppendLine("ADDITIONAL INFO:");
        sb.AppendLine(new string('-', 40));
        sb.AppendLine($"  Timestamp: {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss.fff} UTC");
        sb.AppendLine($"  User Agent: {request.Headers.UserAgent.FirstOrDefault() ?? "N/A"}");
        sb.AppendLine($"  Accept: {request.Headers.Accept.FirstOrDefault() ?? "N/A"}");
        sb.AppendLine($"  Accept-Encoding: {request.Headers.AcceptEncoding.FirstOrDefault() ?? "N/A"}");
        sb.AppendLine($"  Accept-Language: {request.Headers.AcceptLanguage.FirstOrDefault() ?? "N/A"}");

        sb.AppendLine(new string('=', 80));

        Console.WriteLine(sb.ToString());
    }

    /// <summary>
    /// Conditionally prints the HTTP request details based on a condition.
    /// </summary>
    /// <param name="request">The HTTP request to log</param>
    /// <param name="shouldLog">Condition to determine whether to log</param>
    /// <param name="includeBody">Whether to include the request body in the output</param>
    /// <returns>A task representing the asynchronous operation</returns>
    public static async Task PrintRequestDetailsAsync(this HttpRequest request, bool shouldLog, bool includeBody = true)
    {
        if (shouldLog)
        {
            await request.PrintRequestDetailsAsync(includeBody);
        }
    }

    /// <summary>
    /// Prints a condensed version of the HTTP request details.
    /// </summary>
    /// <param name="request">The HTTP request to log</param>
    /// <returns>A task representing the asynchronous operation</returns>
    public static async Task PrintRequestSummaryAsync(this HttpRequest request)
    {
        var timestamp = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss.fff");
        var userAgent = request.Headers.UserAgent.FirstOrDefault() ?? "N/A";
        var remoteIp = request.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "N/A";

        string bodyInfo = "";
        if (request.ContentLength > 0)
        {
            try
            {
                var originalPosition = request.Body.Position;
                request.Body.Position = 0;

                using var reader = new StreamReader(request.Body, Encoding.UTF8, leaveOpen: true);
                var body = await reader.ReadToEndAsync();

                request.Body.Position = originalPosition;

                bodyInfo = $" | Body: {body.Length} chars";
                if (body.Length > 100)
                {
                    bodyInfo += $" | Preview: {body[..100]}...";
                }
                else if (!string.IsNullOrWhiteSpace(body))
                {
                    bodyInfo += $" | Content: {body}";
                }
            }
            catch (Exception ex)
            {
                bodyInfo = $" | Body read error: {ex.Message}";
            }
        }

        Console.WriteLine($"[{timestamp}] {request.Method} {request.Path}{request.QueryString} | {remoteIp} | {userAgent}{bodyInfo}");
    }


    /// <summary>
    /// Determines if a header contains sensitive information that should be redacted
    /// </summary>
    /// <param name="headerName">The name of the header to check</param>
    /// <returns>True if the header should be redacted, false otherwise</returns>
    private static bool IsSensitiveHeader(string headerName)
    {
        var sensitiveHeaders = new[]
        {
            "authorization",
            "authentication",
            "cookie",
            "set-cookie",
            "x-api-key",
            "x-auth-token",
            "bearer",
            "api-key",
            "access-token",
            "refresh-token",
            "session-id",
            "sessionid",
            "x-session",
            "x-access-token",
            "x-csrf-token",
            "x-xsrf-token"
        };

        return sensitiveHeaders.Any(sensitive =>
            headerName.Contains(sensitive, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Conditionally logs request details to file - comment out the body to disable logging
    /// while keeping the method call in the endpoint for easy re-enabling
    /// </summary>
    /// <param name="request">The HTTP request to log</param>
    /// <returns>A task representing the asynchronous operation</returns>
    public static async Task LogRequestAsync(this HttpRequest request)
    {
        string? rawContent = null;
        var timestamp = DateTime.UtcNow;

        try
        {
            // Read the request body (EnableBuffering should be called in middleware)
            using var reader = new StreamReader(request.Body, leaveOpen: true);
            rawContent = await reader.ReadToEndAsync();

            // Reset the stream position so the adapter can read it again
            request.Body.Position = 0;

            // Save detailed request information to file
            await SaveRequestToFileAsync(request, rawContent, timestamp);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[{timestamp:yyyy-MM-dd HH:mm:ss.fff} UTC] Error reading request body: {ex.Message}");

            // Reset position to beginning if possible
            try
            {
                request.Body.Position = 0;
            }
            catch
            {
                // If we can't reset, log the issue but continue
                Console.WriteLine("  Warning: Could not reset request body stream position");
            }
        }
    }

    /// <summary>
    /// Saves detailed request information to a file
    /// </summary>
    /// <param name="request">The HTTP request to save</param>
    /// <param name="requestBody">The request body content</param>
    /// <param name="timestamp">The timestamp when the request was received</param>
    /// <returns>A task representing the asynchronous operation</returns>
    public static async Task SaveRequestToFileAsync(HttpRequest request, string? requestBody, DateTime timestamp)
    {
        const string filePath = @"c:\response\requests.txt";

        FileStream? fileStream = null;
        StreamWriter? writer = null;

        try
        {
            var requestDetails = new StringBuilder();

            // Add separator and timestamp
            requestDetails.AppendLine("=".PadRight(80, '='));
            requestDetails.AppendLine($"Request captured at: {timestamp:yyyy-MM-dd HH:mm:ss.fff} UTC");
            requestDetails.AppendLine("=".PadRight(80, '='));

            // Basic request information
            requestDetails.AppendLine($"Method: {request.Method}");
            requestDetails.AppendLine($"Path: {request.Path}");
            requestDetails.AppendLine($"Query String: {request.QueryString}");
            requestDetails.AppendLine($"Protocol: {request.Protocol}");
            requestDetails.AppendLine($"Scheme: {request.Scheme}");
            requestDetails.AppendLine($"Host: {request.Host}");
            requestDetails.AppendLine($"Content-Type: {request.ContentType ?? "N/A"}");
            requestDetails.AppendLine($"Content-Length: {request.ContentLength?.ToString() ?? "N/A"}");

            // Request Headers (filtered for security)
            requestDetails.AppendLine();
            requestDetails.AppendLine("REQUEST HEADERS:");
            requestDetails.AppendLine("-".PadRight(40, '-'));

            foreach (var header in request.Headers)
            {
                // Filter out sensitive headers
                if (IsSensitiveHeader(header.Key))
                {
                    requestDetails.AppendLine($"{header.Key}: [REDACTED]");
                }
                else
                {
                    requestDetails.AppendLine($"{header.Key}: {string.Join(", ", header.Value.ToArray())}");
                }
            }

            // Request Body
            requestDetails.AppendLine();
            requestDetails.AppendLine("REQUEST BODY:");
            requestDetails.AppendLine("-".PadRight(40, '-'));

            if (!string.IsNullOrEmpty(requestBody))
            {
                // Try to pretty-print JSON if it's JSON content
                if (request.ContentType?.Contains("application/json") == true)
                {
                    try
                    {
                        var jsonDocument = JsonDocument.Parse(requestBody);
                        var prettyJson = JsonSerializer.Serialize(jsonDocument, new JsonSerializerOptions
                        {
                            WriteIndented = true
                        });
                        requestDetails.AppendLine(prettyJson);
                    }
                    catch
                    {
                        // If JSON parsing fails, just append the raw content
                        requestDetails.AppendLine(requestBody);
                    }
                }
                else
                {
                    requestDetails.AppendLine(requestBody);
                }
            }
            else
            {
                requestDetails.AppendLine("(No body content)");
            }

            requestDetails.AppendLine();
            requestDetails.AppendLine();

            // Append to file with proper file locking and explicit resource management
            var fileContent = requestDetails.ToString();
            Console.Write(fileContent);

            // Create FileStream with explicit sharing settings to prevent locks
            fileStream = new FileStream(filePath, FileMode.Append, FileAccess.Write, FileShare.Read,
                bufferSize: 4096, useAsync: true);

            // Create StreamWriter with UTF8 encoding
            writer = new StreamWriter(fileStream, Encoding.UTF8);

            // Write content asynchronously
            await writer.WriteAsync(fileContent);
            await writer.FlushAsync();

            Console.WriteLine($"Request details saved to: {filePath}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error saving request to file: {ex.Message}");
        }
        finally
        {
            // Explicitly dispose resources in the correct order to ensure file handles are released
            try
            {
                if (writer != null)
                {
                    await writer.FlushAsync();
                    writer.Dispose();
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error disposing StreamWriter: {ex.Message}");
            }

            try
            {
                fileStream?.Dispose();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error disposing FileStream: {ex.Message}");
            }
        }
    }

}