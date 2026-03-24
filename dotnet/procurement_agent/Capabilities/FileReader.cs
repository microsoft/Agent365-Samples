namespace ProcurementA365Agent.Capabilities;

using System.Text;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Microsoft.Graph;
using Microsoft.Graph.Models;

public sealed class FileReader(GraphServiceClient graphClient)
{
    public async Task<string> ReadFile(string fileId, CancellationToken cancellationToken)
    {
        var drive = await graphClient.Me.Drive.GetAsync(cancellationToken: cancellationToken);
        var driveItem = await graphClient
            .Drives[drive?.Id]
            .Items[fileId]
            .GetAsync(cancellationToken: cancellationToken);

        if (driveItem?.Workbook is { } workbook)
        {
            return await Task.FromResult(new ExcelReader().ReadExcel(workbook, cancellationToken));
        }

        await using var stream = await graphClient
            .Drives[drive?.Id]
            .Items[fileId]
            .Content
            .GetAsync(cancellationToken: cancellationToken);
        
        if (stream == null)
        {
            throw new Exception($"Error getting stream for fileId {fileId}");
        }
        
        return await ReadStream(driveItem, stream, cancellationToken);
    }

    public async Task<string> ReadSharedFile(string sharingUrl, CancellationToken cancellationToken)
    {
        var encodedUrl = EncodeSharingUrl(sharingUrl);
        
        var driveItem = await graphClient
            .Shares[encodedUrl]
            .DriveItem
            .GetAsync(cancellationToken: cancellationToken);
        
        await using var stream = await graphClient
            .Shares[encodedUrl]
            .DriveItem
            .Content
            .GetAsync(cancellationToken: cancellationToken);
        
        if (stream == null)
        {
            throw new Exception("Error getting stream for sharingUrl");
        }
        
        return await ReadStream(driveItem, stream, cancellationToken);
    }

    private static async Task<string> ReadStream(
        DriveItem? driveItem, Stream stream, CancellationToken cancellationToken)
    {
        var extension = driveItem?.Name?.Split('.').LastOrDefault() ?? string.Empty;
        if (extension == "xlsx")
        {
            return new ExcelReader().ReadExcel(stream);
        }
        else if (extension == "docx")
        {
            using var wordprocessingDocument = WordprocessingDocument.Open(stream, false);
            var mainDocumentPart = wordprocessingDocument.MainDocumentPart ?? wordprocessingDocument.AddMainDocumentPart();
            var body = mainDocumentPart.Document.Body ?? mainDocumentPart.Document.AppendChild(new Body());
            return body.InnerText;
        }

        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync(cancellationToken);
    }

    private string EncodeSharingUrl(string sharingUrl)
    {
        var base64Value = Convert.ToBase64String(Encoding.UTF8.GetBytes(sharingUrl));
        return "u!" + base64Value.TrimEnd('=').Replace('/','_').Replace('+','-');
    }
}