namespace ProcurementA365Agent.NotificationService;

using Microsoft.Kiota.Abstractions.Serialization;

public class IdentityParent : IParsable
{
    private const string IdKey = "id";
    public string? Id { get; set; }
    
    public IDictionary<string, Action<IParseNode>> GetFieldDeserializers() => 
        new Dictionary<string, Action<IParseNode>>
        {
            { IdKey, n => { Id = n.GetStringValue(); } }
        };

    public void Serialize(ISerializationWriter writer)
    {
        writer.WriteStringValue(IdKey, Id);
    }
}