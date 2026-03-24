namespace ProcurementA365Agent.NotificationService;

using Microsoft.Graph.Models;
using Microsoft.Kiota.Abstractions.Serialization;

public class AgentUserEntity : User
{
    public AgentUserEntity()
    {
        OdataType = "microsoft.graph.agentUser";
    }
    
    public IdentityParent? IdentityParent
    {
        get => BackingStore.Get<IdentityParent?>("identityParent");
        set => BackingStore.Set("identityParent", value);
    }

    public override void Serialize(ISerializationWriter writer)
    {
        base.Serialize(writer);
        writer.WriteObjectValue("identityParent", IdentityParent);
    }
}