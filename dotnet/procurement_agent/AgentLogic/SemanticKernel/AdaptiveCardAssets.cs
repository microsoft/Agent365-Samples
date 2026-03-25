using Microsoft.Crm.Sdk.Messages;

namespace ProcurementA365Agent.AgentLogic.SemanticKernel
{
    public class AdaptiveCardAssets
    {
        public static string SpinnerSvg = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgc3Ryb2tlPSIjZTVlN2ViIiBzdHJva2Utd2lkdGg9IjIiLz4KICA8cGF0aCBkPSJNMTIsMiBBMTAsMTAgMCAwLDEgMjIsMTIiIHN0cm9rZT0iIzAwN2FjYyIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPgogICAgPGFuaW1hdGVUcmFuc2Zvcm0gYXR0cmlidXRlTmFtZT0idHJhbnNmb3JtIiBhdHRyaWJ1dGVUeXBlPSJYTUwiIHR5cGU9InJvdGF0ZSIgZnJvbT0iMCAxMiAxMiIgdG89IjM2MCAxMiAxMiIgZHVyPSIxcyIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiLz4KICA8L3BhdGg+Cjwvc3ZnPg==";
        public static string ToggleChevronSvg = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQgMTBsNC00IDQgNCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPC9zdmc+";
        public static string Response = @"<strong>Purchase Recommendation Summary</strong>:<ul><li><strong>Item:</strong> Proseware Pro Laptop</li><li><strong>Quantity:</strong> 4 units</li><li><strong>Ship-to:</strong> Northwind Traders HQ, 123 Innovation Drive, Seattle, WA</li><li><strong>Bill-to:</strong> Cost Center IT-HW-2025</li><li><strong>Required Delivery:</strong> Next week</li></ul><p>Supplier Research:</p><ul><li>Adatum Corporation: 98% on-time delivery, $1,200/unit, ETA 5 days, median lead time: 6 days</li><li>Boulder Innovations: 90% on-time delivery, $1,150/unit, ETA 7 days, median lead time: 8 days</li></ul><p><strong>Recommended Supplier:</strong> Adatum Corporation (reliable delivery, fits timeline)</p><p style=\'color:#b71c1c;\'><br/><strong>Action Required:</strong> Please confirm approval to proceed with Adatum Corporation at $1,200 per unit for timely delivery.</p>";
    }
}
