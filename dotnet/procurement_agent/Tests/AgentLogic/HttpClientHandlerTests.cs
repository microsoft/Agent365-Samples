namespace ProcurementA365Agent.Tests.AgentLogic
{
    using System.Net;
    using System.Text;
    using ProcurementA365Agent.Mcp;
    using ProcurementA365Agent.Models;
    using ProcurementA365Agent.Services;
    using Microsoft.Extensions.Logging;
    using Moq;
    using Moq.Protected;
    using Xunit;

    public class HttpClientHandlerTests
    {
        private readonly Mock<ILogger> _mockLogger;
        private readonly AgentMetadata _testAgent;
        private readonly string _mcpEndpoint;
        private readonly AgentTokenHelper _realTokenHelper;

        public HttpClientHandlerTests()
        {
            _mockLogger = new Mock<ILogger>();
            _testAgent = new AgentMetadata
            {
                AgentId = Guid.NewGuid(),
                AgentApplicationId = Guid.NewGuid(),
                TenantId = Guid.NewGuid(),
                EmailId = "test@example.com",
                AgentFriendlyName = "Test Agent"
            };
            _mcpEndpoint = "https://agent365.sandbox.dev.microsoft/mcp/environment/test-env/server/TestServer/version/1.0";
            _realTokenHelper = new AgentTokenHelper(Mock.Of<ILogger<AgentTokenHelper>>());
        }

        #region McpClientHttpRequestLogger Tests

        [Fact]
        public async Task McpClientHttpRequestLogger_LogsRequestAndResponse_WhenSendAsyncCalled()
        {
            // Arrange
            var logger = _mockLogger.Object;
            var handler = new McpClientHttpRequestLogger(logger);
            
            // Create a mock inner handler that returns a test response
            var mockInnerHandler = new Mock<HttpMessageHandler>();
            var expectedResponse = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("Test response body", Encoding.UTF8, "application/json")
            };
            expectedResponse.Headers.Add("X-Test-Header", "test-value");

            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(expectedResponse);

            handler.InnerHandler = mockInnerHandler.Object;

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "https://test.example.com/api/test")
            {
                Content = new StringContent("Test request body", Encoding.UTF8, "application/json")
            };
            request.Headers.Add("X-Custom-Header", "custom-value");

            var httpClient = new HttpClient(handler);

            // Act
            var response = await httpClient.SendAsync(request);

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            
            // Verify that logging methods were called
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("HTTP Request:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);

            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("HTTP Response:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);
        }

        [Fact]
        public async Task McpClientHttpRequestLogger_HandlesRequestWithoutContent()
        {
            // Arrange
            var logger = _mockLogger.Object;
            var handler = new McpClientHttpRequestLogger(logger);
            
            var mockInnerHandler = new Mock<HttpMessageHandler>();
            var expectedResponse = new HttpResponseMessage(HttpStatusCode.NoContent);

            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(expectedResponse);

            handler.InnerHandler = mockInnerHandler.Object;

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Delete, "https://test.example.com/api/test");
            var httpClient = new HttpClient(handler);

            // Act
            var response = await httpClient.SendAsync(request);

            // Assert
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            
            // Verify logging was called for request
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("HTTP Request:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);
        }

        [Fact]
        public async Task McpClientHttpRequestLogger_HandlesResponseWithoutContent()
        {
            // Arrange
            var logger = _mockLogger.Object;
            var handler = new McpClientHttpRequestLogger(logger);
            
            var mockInnerHandler = new Mock<HttpMessageHandler>();
            var expectedResponse = new HttpResponseMessage(HttpStatusCode.OK); // No content

            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(expectedResponse);

            handler.InnerHandler = mockInnerHandler.Object;

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "https://test.example.com/api/test");
            var httpClient = new HttpClient(handler);

            // Act
            var response = await httpClient.SendAsync(request);

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            
            // Verify logging was called
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.IsAny<It.IsAnyType>(),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);
        }

        #endregion

        #region MCPAuthenticationHandler Constructor Tests

        [Fact]
        public void MCPAuthenticationHandler_ThrowsArgumentException_WhenEndpointIsEmpty()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";

            // Act & Assert
            Assert.Throws<ArgumentException>(() => new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, ""));
        }

        [Fact]
        public void MCPAuthenticationHandler_ThrowsArgumentException_WhenEndpointIsNull()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";

            // Act & Assert
            Assert.Throws<ArgumentException>(() => new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, null!));
        }

        [Fact]
        public void MCPAuthenticationHandler_ThrowsArgumentNullException_WhenLoggerIsNull()
        {
            // Arrange
            var validCertData = "fake-cert-data";

            // Act & Assert
            Assert.Throws<ArgumentNullException>(() => new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, null!, _mcpEndpoint));
        }

        [Fact]
        public void MCPAuthenticationHandler_CreatesSuccessfully_WithValidParameters()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";

            // Act
            var handler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, _mcpEndpoint);

            // Assert
            Assert.NotNull(handler);
        }

        [Fact]
        public void MCPAuthenticationHandler_CreatesSuccessfully_WithCustomScopes()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";
            var customScopes = new[] { "https://custom.scope/.default", "https://another.scope/.default" };

            // Act
            var handler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, _mcpEndpoint, customScopes);

            // Assert
            Assert.NotNull(handler);
        }

        [Fact]
        public void MCPAuthenticationHandler_CreatesSuccessfully_WithNullScopes()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";

            // Act
            var handler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, _mcpEndpoint, null);

            // Assert
            Assert.NotNull(handler);
        }

        #endregion

        #region MCPAuthenticationHandler Endpoint Matching Tests

        [Fact]
        public async Task MCPAuthenticationHandler_SkipsAuthentication_WithNonMatchingEndpoint()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";
            
            var handler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, _mcpEndpoint);

            var mockInnerHandler = new Mock<HttpMessageHandler>();
            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK));

            handler.InnerHandler = mockInnerHandler.Object;

            // Use a different endpoint that won't match
            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "https://different-service.com/api/test");
            var httpClient = new HttpClient(handler);

            // Act & Assert - Should not throw exception and should skip authentication
            var response = await httpClient.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        [Fact]
        public async Task MCPAuthenticationHandler_HandlesRequestWithBaseAddress()
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";
            
            var handler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, _mcpEndpoint);

            var mockInnerHandler = new Mock<HttpMessageHandler>();
            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK));

            handler.InnerHandler = mockInnerHandler.Object;

            // Create an HttpClient with a BaseAddress and use a relative URI
            var httpClient = new HttpClient(handler)
            {
                BaseAddress = new Uri("https://different-service.com/")
            };

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "api/test");

            // Act & Assert - Should not throw exception
            var response = await httpClient.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        #endregion

        #region Integration Tests

        [Fact]
        public async Task HttpClientHandlerChain_WorksTogether_LoggingAndAuthentication()
        {
            // Arrange
            var validCertData = "fake-cert-data";
            
            // Create handler chain: Logger -> Auth -> Mock Inner Handler
            var mockInnerHandler = new Mock<HttpMessageHandler>();
            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("Success", Encoding.UTF8, "application/json")
                });

            var authHandler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, _mockLogger.Object, _mcpEndpoint)
            {
                InnerHandler = mockInnerHandler.Object
            };

            var loggingHandler = new McpClientHttpRequestLogger(_mockLogger.Object)
            {
                InnerHandler = authHandler
            };

            // Use a non-matching endpoint to avoid certificate issues
            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "https://different-service.com/api/test");
            var httpClient = new HttpClient(loggingHandler);

            // Act
            var response = await httpClient.SendAsync(request);

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            
            // Verify that logging occurred
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("HTTP Request:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);
        }

        #endregion

        #region Edge Case Tests

        [Theory]
        [InlineData("https://different-service.com/api/test")]
        [InlineData("https://agent365.other-domain.com/mcp/environment/test-env/server/TestServer/version/1.0")]
        [InlineData("http://agent365.sandbox.dev.microsoft/mcp/environment/test-env/server/TestServer/version/1.0")]
        [InlineData("https://agent365.sandbox.dev.microsoft:8080/mcp/environment/test-env/server/TestServer/version/1.0")]
        public async Task MCPAuthenticationHandler_HandlesVariousNonMatchingEndpoints(string requestUrl)
        {
            // Arrange
            var mockLogger = new Mock<ILogger>().Object;
            var validCertData = "fake-cert-data";
            
            var handler = new McpAuthenticationHandler(
                _realTokenHelper, _testAgent, validCertData, mockLogger, _mcpEndpoint);

            var mockInnerHandler = new Mock<HttpMessageHandler>();
            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK));

            handler.InnerHandler = mockInnerHandler.Object;

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, requestUrl);
            var httpClient = new HttpClient(handler);

            // Act & Assert - Should not throw exception (these endpoints don't match, so no auth is attempted)
            var response = await httpClient.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        [Fact]
        public async Task McpClientHttpRequestLogger_LogsHeaders_WhenHeadersPresent()
        {
            // Arrange
            var logger = _mockLogger.Object;
            var handler = new McpClientHttpRequestLogger(logger);
            
            var mockInnerHandler = new Mock<HttpMessageHandler>();
            var expectedResponse = new HttpResponseMessage(HttpStatusCode.OK);
            expectedResponse.Headers.Add("X-Custom-Response-Header", "response-value");

            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ReturnsAsync(expectedResponse);

            handler.InnerHandler = mockInnerHandler.Object;

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "https://test.example.com/api/test");
            request.Headers.Add("X-Custom-Request-Header", "request-value");
            var httpClient = new HttpClient(handler);

            // Act
            var response = await httpClient.SendAsync(request);

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            
            // Verify that request headers were logged
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("Request Headers:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);

            // Verify that response headers were logged
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("Response Headers:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);
        }

        [Fact]
        public async Task McpClientHttpRequestLogger_HandlesExceptionInInnerHandler()
        {
            // Arrange
            var logger = _mockLogger.Object;
            var handler = new McpClientHttpRequestLogger(logger);
            
            var mockInnerHandler = new Mock<HttpMessageHandler>();
            mockInnerHandler.Protected()
                .Setup<Task<HttpResponseMessage>>(
                    "SendAsync",
                    ItExpr.IsAny<HttpRequestMessage>(),
                    ItExpr.IsAny<CancellationToken>())
                .ThrowsAsync(new HttpRequestException("Test exception"));

            handler.InnerHandler = mockInnerHandler.Object;

            var request = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, "https://test.example.com/api/test");
            var httpClient = new HttpClient(handler);

            // Act & Assert
            var exception = await Assert.ThrowsAsync<HttpRequestException>(() => httpClient.SendAsync(request));
            Assert.Equal("Test exception", exception.Message);
            
            // Verify that request was still logged
            _mockLogger.Verify(
                x => x.Log(
                    LogLevel.Information,
                    It.IsAny<EventId>(),
                    It.Is<It.IsAnyType>((v, t) => v.ToString()!.Contains("HTTP Request:")),
                    It.IsAny<Exception>(),
                    It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
                Times.AtLeastOnce);
        }

        #endregion
    }
}