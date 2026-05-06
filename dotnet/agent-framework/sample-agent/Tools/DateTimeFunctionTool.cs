// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.ComponentModel;

namespace Agent365AgentFrameworkSampleAgent.Tools
{
    public class DateTimeFunctionTool
    {
        [Description("Use this tool to get the current date and time")]
        public string GetCurrentDateTime()
        {
            return DateTimeOffset.Now.ToString("D", null);
        }
    }
}
