namespace ProcurementA365Agent.Tests.Services
{
    using ProcurementA365Agent.Services;
    using Xunit;

    public class GraphServiceTests
    {
        [Fact]
        public void MessageSelectFields_ShouldIncludeConversationId()
        {
            // Act
            var selectFields = GraphService.MessageSelectFields;

            // Assert
            Assert.Contains("conversationId", selectFields);
        }
    }
}