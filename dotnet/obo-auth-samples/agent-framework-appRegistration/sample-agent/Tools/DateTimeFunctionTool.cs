// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.ComponentModel;

namespace Agent365AgentFrameworkSampleAgent.Tools
{
    public static class DateTimeFunctionTool
    {
        [Description("Use this tool to get the current date and time")]
        public static string getDate(string input)
        {
            string date = DateTimeOffset.Now.ToString("D", null);
            return date;
        }
    }
}
