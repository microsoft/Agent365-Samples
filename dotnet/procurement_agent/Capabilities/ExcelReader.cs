namespace ProcurementA365Agent.Capabilities;

using System.Globalization;
using System.Text;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using Microsoft.Kiota.Abstractions.Serialization;
using Workbook = Microsoft.Graph.Models.Workbook;

public sealed class ExcelReader()
{
    public string ReadExcel(
        Workbook workbook, CancellationToken cancellationToken)
    {
        var worksheets = workbook.Worksheets;
        var firstSheet = worksheets?.FirstOrDefault();
        var table = firstSheet?.Tables?.FirstOrDefault();
        var rows = table?.Rows ?? [];

        var sb = new StringBuilder();
        foreach (var row in rows)
        {
            if (row.Values is UntypedArray columns)
            {
                foreach (var column in columns.GetValue())
                {
                    var value = GetValue(column);
                    sb.Append(value).Append('\t');
                }
            }
        }

        return sb.ToString();
    }

    public string ReadExcel(Stream stream)
    {
        using var spreadsheetDocument = SpreadsheetDocument.Open(stream, false);
        if (spreadsheetDocument.WorkbookPart is { } workbookPart)
        {
            var sb = new StringBuilder();
            var stringTable = workbookPart.GetPartsOfType<SharedStringTablePart>().FirstOrDefault();
            
            foreach (var worksheetPart in workbookPart.WorksheetParts)
            {
                var sheetData = worksheetPart.Worksheet.Elements<SheetData>().FirstOrDefault();
                foreach (var r in sheetData?.Elements<Row>() ?? [])
                {
                    Console.WriteLine(r.RowIndex?.ToString());
                    foreach (var c in r.Elements<Cell>())
                    {
                        var cellValueText = c.CellValue?.Text;
                        var content = stringTable != null && int.TryParse(cellValueText, out var parsedIndex) && parsedIndex < stringTable.SharedStringTable.Count()
                            ? stringTable.SharedStringTable.ElementAt(parsedIndex).InnerText
                            : cellValueText;
                        
                        Console.WriteLine(content);
                        sb.Append(content).Append('\t');
                    }

                    sb.AppendLine();
                }
            }
            
            return sb.ToString();
        }
        else
        {
            return string.Empty;       
        }
    }

    private string? GetValue(UntypedNode column)
    {
        if (column is UntypedBoolean untypedBoolean)
        {
            return untypedBoolean.GetValue().ToString();
        }
        else if (column is UntypedDecimal untypedDecimal)
        {
            return untypedDecimal.GetValue().ToString(CultureInfo.InvariantCulture);
        }
        else if (column is UntypedDouble untypedDouble)
        {
            return untypedDouble.GetValue().ToString(CultureInfo.InvariantCulture);
        }
        else if (column is UntypedFloat untypedFloat)
        {
            return untypedFloat.GetValue().ToString(CultureInfo.InvariantCulture);
        }
        else if (column is UntypedInteger untypedInteger)
        {
            return untypedInteger.GetValue().ToString();
        }
        else if (column is UntypedLong untypedLong)
        {
            return untypedLong.GetValue().ToString();
        }
        else if (column is UntypedString untypedString)
        {
            return untypedString.GetValue();
        }

        return column.ToString();
    }
}