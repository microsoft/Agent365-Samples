namespace ProcurementA365Agent
{
    public static class ServiceUtilities
    {
        public static string GetServiceName()
        {
            return Environment.GetEnvironmentVariable("WEBSITE_SITE_NAME") ?? ("local_" + Environment.MachineName);
        }
    }
}
